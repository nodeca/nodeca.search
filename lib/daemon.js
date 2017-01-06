// searchd wrapper/monitor
//

'use strict';

const _         = require('lodash');
const assert    = require('assert');
const Promise   = require('bluebird');
const execFile  = require('child_process').execFile;
const mysql     = require('mysql2/promise');
const fs        = require('mz/fs');
const path      = require('path');
const mkdirp    = Promise.promisify(require('mkdirp'));
const write     = Promise.promisify(require('write-file-atomic'));


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


function Daemon(root) {
  this.root = root;
  this.state = { started: false, configured: false };
  this.config = null;
  this.monitor_timeout = null;

  this.pool = mysql.createPool({
    Promise,
    socketPath: path.join(this.root, 'searchd.sock'),
    connectionLimit: 10
  });
}


Daemon.prototype.start = Promise.coroutine(function* () {
  if (this.state.started) return;

  if (!this.state.configured) {
    try {
      this.config = JSON.parse(yield fs.readFile(path.join(this.root, 'config.json'), 'utf8'));
    } catch (err) {
      let error = new Error('Cannot load config: ' + err.message);
      error.code = 'EBADCONFIG';
      throw error;
    }

    // create subfolders
    yield mkdirp(path.join(this.root, 'binlog'));
    yield mkdirp(path.join(this.root, 'tables'));

    /*for (let index of Object.keys(this.config.indexes || {})) {
      yield mkdirp(path.join(this.root, index.replace(/\//g, '')));
    }*/

    yield write(path.join(this.root, 'searchd.conf'),
            create_sphinx_config(this.root, this.config));

    this.state.configured = true;
  }

  yield this.__launch_daemon__();
});


Daemon.prototype.stop = Promise.coroutine(function* () {
  if (!this.state.started) return;

  try {
    // searchd is started if pid_file exists and non-empty
    assert.notEqual((yield fs.stat(path.join(this.root, 'pid_file'))).size, 0);

    // stop searchd instance, ignore errors
    yield this.__exec_searchd__('--stopwait', '-c', 'searchd.conf');
  } catch (err) {}

  this.state.started = false;
});


Daemon.prototype.execute = Promise.coroutine(function* (query, count) {
  let connection = yield this.pool.getConnection();

  try {
    let response = [];

    response[0] = (yield connection.query(query))[0];

    if (count) {
      response[1] = yield connection.query("SHOW META LIKE 'total'");
    }

    return response;
  } finally {
    connection.release();
  }
});


Daemon.prototype.__exec_searchd__ = function (...args) {
  return Promise.fromCallback(callback => {
    execFile(
      this.config.bin || 'searchd',
      args,
      { cwd: this.root },
      (err, stdout, stderr) => {

        if (err) {
          callback(new Error(`Failed to execute 'searchd ${args.join(' ')}': ${err.message || err}${stdout}${stderr}`));
          return;
        }

        callback();
      }
    );
  });
};


Daemon.prototype.__launch_daemon__ = Promise.coroutine(function* () {
  try {
    // previous instance is started if pid_file exists and non-empty
    assert.notEqual((yield fs.stat(path.join(this.root, 'pid_file'))).size, 0);

    // stop previous searchd instance, ignore errors
    yield this.__exec_searchd__('--stopwait', '-c', 'searchd.conf');
  } catch (err) {}

  yield this.__exec_searchd__('-c', 'searchd.conf');

  try {
    yield this.execute("SHOW STATUS LIKE 'uptime'");
  } catch (err) {
    throw new Error(`Cannot query searchd: ${err.message || err}`);
  }

  this.state.started = true;
  this.__monitor_tick__();
});


// Function that pings searchd every 5 seconds,
// and restarts searchd on any errors
//
Daemon.prototype.__monitor_tick__ = function () {
  clearTimeout(this.monitor_timeout);

  this.monitor_timeout = setTimeout(() => {
    if (!this.state.started) return;

    this.execute("SHOW STATUS LIKE 'uptime'")
        .then(() => this.__monitor_tick__())
        .catch(() => {

          this.__launch_daemon__()
            .then(() => this.__monitor_tick__(), () => this.__monitor_tick__());
        });
  }, 5000);
};


module.exports = Daemon;
