// searchd wrapper/monitor
//

'use strict';

const _         = require('lodash');
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

    let max_key_len = entries[folder].reduce((acc, kv) => Math.max(acc, kv[0].length), 0);

    result += entries[folder].map(kv =>
      '  ' + kv[0] + ' '.repeat(max_key_len - kv[0].length) + ' = ' + kv[1].trim()
      // add this to support multiple lines as a value:
      // .replace(/\n/g, () => ' \\\n' + ' '.repeat(max_key_len + 5))
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
    socketPath: path.resolve(this.root, 'searchd.sock'),
    connectionLimit: 1
  });
}


Daemon.prototype.start = Promise.coroutine(function* () {
  if (this.state.started) return;

  if (!this.state.configured) {
    this.config = JSON.parse(yield fs.readFile(path.join(this.root, 'config.json'), 'utf8'));

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

  yield this.launch_daemon();
});


Daemon.prototype.launch_daemon = Promise.coroutine(function* () {
  yield Promise.fromCallback(callback => execFile(this.config.bin || 'searchd',
    [ '-c', 'searchd.conf' ],
    { cwd: this.root },
    (err, stdout, stderr) => {

      if (err) {
        callback(new Error(`Cannot start searchd: ${err.message || err}${stdout}${stderr}`));
        return;
      }

      callback();
    }
  ));

  try {
    yield this.execute("SHOW STATUS LIKE 'uptime'");
  } catch (err) {
    throw new Error(`Cannot query searchd: ${err.message || err}`);
  }

  this.state.started = true;
  this.monitor_tick();
});


Daemon.prototype.stop = Promise.coroutine(function* () {
  if (!this.state.started) return;

  yield Promise.fromCallback(callback => execFile(this.config.bin || 'searchd',
    [ '--stop', '-c', 'searchd.conf' ],
    { cwd: this.root },
    (err, stdout, stderr) => {

      if (err) {
        callback(new Error(`Cannot start searchd: ${err.message || err}${stdout}${stderr}`));
        return;
      }

      callback();
    }
  ));

  this.state.started = false;
});


// Function that pings searchd every 5 seconds,
// and restarts searchd on any errors
//
Daemon.prototype.monitor_tick = function () {
  clearTimeout(this.monitor_timeout);

  this.monitor_timeout = setTimeout(() => {
    if (!this.state.started) return;

    this.execute("SHOW STATUS LIKE 'uptime'")
        .then(() => this.monitor_tick())
        .catch(() => {

          this.launch_daemon()
            .then(() => this.monitor_tick(), () => this.monitor_tick());
        });
  }, 5000);
};


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


module.exports = Daemon;
