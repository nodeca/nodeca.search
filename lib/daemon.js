// searchd wrapper/monitor
//
'use strict';


const _             = require('lodash');
const assert        = require('assert');
const execFile      = require('child_process').execFile;
const mysql         = require('mysql2/promise');
const mysql_escape  = require('mysql2').escape;
const path          = require('path');
const { promisify } = require('util');
const readFile      = promisify(require('fs').readFile);
const stat          = promisify(require('fs').stat);
const mkdirp        = require('mkdirp');
const rimraf        = promisify(require('rimraf'));
const write         = promisify(require('write-file-atomic'));


const STATE_INIT     = 0;
const STATE_STOPPED  = 1;
const STATE_RUNNING  = 2;

const conf_paths = [
  'binlog_path',
  'pid_file',
  'listen',
  'stopwords',
  'wordforms',
  'lemmatizer_base',
  'log',
  'query_log',
  'path'
];


// emulate prepared statements because sphinx doesn't support those
function prepare_query(query, args) {
  if (!args) args = [];

  let i = 0;

  return query.replace(/\?/g, () => mysql_escape(args[i++]));
}


function create_sphinx_config(root, config) {
  let entries = {};

  function path_resolve(p) {
    // Keep intact absolute paths
    if (p[0] === '/') return p;

    // Resolve paths in npm packages
    if (/^npm:/.test(p)) {
      let p_splitted = p.slice(4).split('/');
      let pkg = p_splitted[0];
      p_splitted[0] = path.dirname(require.resolve(`${pkg}/package.json`));
      return p_splitted.join(path.sep);
    }

    // Resolve relative paths
    return path.join(root, p);
  }

  function add(folder, key, values) {
    if (!Array.isArray(values)) values = [ values ];

    values.forEach(value => {
      entries[folder] = entries[folder] || [];

      if (conf_paths.indexOf(String(key)) !== -1) {
        value = path_resolve(String(value));
      }

      entries[folder].push([ String(key), String(value) ]);
    });
  }

  // All searchd and common entries are copied as is, and:
  //  - all arrays are expanded into multiple kv pairs with the same name
  //  - paths (everything not starting with '/') are expanded to full paths
  //  - paths starting with `npm:` are expanded like npm require does
  //
  [ 'searchd', 'common' ].forEach(section => {
    Object.keys(config[section] || {}).forEach(k => {
      add(section, k, config[section][k]);
    });
  });

  // Everything inside 'indexes' is assumed to be index definition (key-value
  // pair, where key is "index_name" or "index_name : parent" and value
  // is a hash expanded using substitutions described above.
  //
  if (config.indexes) {
    Object.keys(config.indexes).sort().forEach(i => {
      let folder = 'index ' + i;

      Object.keys(config.indexes[i] || {}).forEach(k => {
        add(folder, k, config.indexes[i][k]);
      });

      if (!_.get(config.indexes[i], 'path')) {
        add(folder, 'path', path.join('tables', i.split(':')[0].trim()));
      }
    });
  }

  return Object.keys(entries).map(folder => {
    let result = `${folder} {\n`;

    result += entries[folder].map(kv =>
      `  ${kv[0]} = ${kv[1].trim()}`
    ).join('\n');

    result += '\n}\n';

    return result;
  }).join('\n');
}


// decorator that executes each of the functions one after another
// in call order, used to prevent race conditions
function enqueue_wrap(fn) {
  return function () {
    if (this.queue.length && this.queue[this.queue.length - 1].method === fn) {
      return this.queue[this.queue.length - 1].promise;
    }

    const call_fn = () =>
      fn.apply(this, arguments).then(
        // finally
        data => {
          if (this.queue[0].method === fn) this.queue.shift();
          return data;
        },
        err => {
          if (this.queue[0].method === fn) this.queue.shift();
          throw err;
        }
      );

    let promise = this.queue.length > 0 ?
                  this.queue[this.queue.length - 1].promise.then(call_fn, call_fn) :
                  call_fn();

    this.queue.push({ method: fn, promise });
    return promise;
  };
}


function Daemon(root) {
  this.root = root;
  this.state = STATE_INIT;
  this.config = null;
  this.monitor_timeout = null;
  this.queue = [];
  this.pool = null;
}


Daemon.prototype.__start__ = async function start() {
  if (this.state === STATE_RUNNING) return;

  if (this.state === STATE_INIT) {
    try {
      this.config = JSON.parse(await readFile(path.join(this.root, 'config.json'), 'utf8'));
    } catch (err) {
      let error = new Error('Cannot load config: ' + err.message);
      error.code = 'EBADCONFIG';
      throw error;
    }

    // create subfolders
    await mkdirp(path.join(this.root, 'binlog'));
    await mkdirp(path.join(this.root, 'tables'));

    /*for (let index of Object.keys(this.config.indexes || {})) {
      await mkdirp(path.join(this.root, index.replace(/\//g, '')));
    }*/

    await write(path.join(this.root, 'searchd.conf'),
            create_sphinx_config(this.root, this.config));

    this.state = STATE_STOPPED;
  }

  this.pool = mysql.createPool({
    Promise,
    socketPath: path.join(this.root, 'searchd.sock'),
    connectionLimit: 10,

    // workaround for sphinx returning UTF8_GENERAL_CI instead of UTF8MB4_GENERAL_CI
    // https://github.com/sidorares/node-mysql2/issues/507#issuecomment-278618713
    typeCast(field, next) {
      if (field.type === 'STRING') {
        return field.buffer().toString('utf-8');
      }
      return next();
    }
  });

  let searchd_started = false;

  try {
    // previous instance is started if:
    //  - pid_file exists and non-empty
    //  - searchd responds to sql queries
    //
    let result = await stat(path.join(this.root, 'pid_file'));

    if (result.size !== 0) {
      await this.execute("SHOW STATUS LIKE 'uptime'");
      searchd_started = true;
    }
  } catch (err) {}

  if (!searchd_started) {
    await this.__exec_searchd__('-c', 'searchd.conf');

    // verify that it's started successfully
    try {
      await this.execute("SHOW STATUS LIKE 'uptime'");
    } catch (err) {
      throw new Error(`Cannot query searchd: ${err.message || err}`);
    }
  }

  this.state = STATE_RUNNING;
  this.wait_for_start = null;
  this.__monitor_tick__();
};


Daemon.prototype.__stop__ = async function stop() {
  if (this.state === STATE_STOPPED || this.state === STATE_INIT) return;

  try {
    // searchd is started if pid_file exists and non-empty
    assert.notEqual((await stat(path.join(this.root, 'pid_file'))).size, 0);

    await this.pool.end();

    this.state = STATE_STOPPED;
    this.pool = null;

    // stop searchd instance, ignore errors
    await this.__exec_searchd__('--stopwait', '-c', 'searchd.conf');
  } catch (err) {}
};


Daemon.prototype.__create__ = async function create(config) {
  await mkdirp(this.root);
  await write(path.join(this.root, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  await this.__start__();
};


Daemon.prototype.__destroy__ = async function destroy() {
  await this.__stop__();
  await rimraf(this.root);
};


Daemon.prototype.start   = enqueue_wrap(Daemon.prototype.__start__);
Daemon.prototype.stop    = enqueue_wrap(Daemon.prototype.__stop__);
Daemon.prototype.create  = enqueue_wrap(Daemon.prototype.__create__);
Daemon.prototype.destroy = enqueue_wrap(Daemon.prototype.__destroy__);


// execute(query, args) -> result
// execute([ query, query, ... ]) -> [ result, result, ... ]
// execute([ [ query, args ], [ query, args ], ... ]) -> [ result, result, ... ]
//
Daemon.prototype.execute = async function execute(queries, args) {
  if (!this.pool) throw new Error('searchd is not started');

  let connection = await this.pool.getConnection();
  let response;

  try {
    if (Array.isArray(queries)) {
      response = [];

      for (let query of queries) {
        /* eslint-disable max-depth */
        if (Array.isArray(query)) {
          // execute([ [ query, args ] ])
          response.push((await connection.query(prepare_query(query[0], query[1])))[0]);
        } else {
          // execute([ query ])
          response.push((await connection.query(query))[0]);
        }
      }
    } else {
      // execute(query, args)
      response = (await connection.query(prepare_query(queries, args)))[0];
    }

    return response;
  } finally {
    connection.release();
  }
};


Daemon.prototype.__exec_searchd__ = function exec_searchd(...args) {
  return new Promise((resolve, reject) => {
    execFile(
      this.config.bin || 'searchd',
      args,
      { cwd: this.root },
      (err, stdout, stderr) => {

        if (err) {
          reject(new Error(`Failed to execute 'searchd ${args.join(' ')}': ${err.message || err}${stdout}${stderr}`));
          return;
        }

        resolve();
      }
    );
  });
};


// Function that pings searchd every 5 seconds,
// and restarts searchd on any errors
//
Daemon.prototype.__monitor_tick__ = function monitor_tick() {
  clearTimeout(this.monitor_timeout);

  this.monitor_timeout = setTimeout(() => {
    if (this.state !== STATE_RUNNING) return;

    this.execute("SHOW STATUS LIKE 'uptime'")
        .then(() => this.__monitor_tick__())
        .catch(() => {
          if (this.state !== STATE_RUNNING) return;

          this.state = STATE_STOPPED;

          this.start()
            .then(() => this.__monitor_tick__(), () => this.__monitor_tick__());
        });
  }, 5000);
};


module.exports = Daemon;
