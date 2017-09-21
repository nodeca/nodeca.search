// Public search interface
//

'use strict';

const _         = require('lodash');
const assert    = require('assert');
const Promise   = require('bluebird');
const http      = require('http');
const readFile    = require('util').promisify(require('fs').readFile);
const path      = require('path');
const serialize = require('serialize-error');
const url       = require('url');
const Daemon    = require('./daemon');
const mkdirp    = Promise.promisify(require('mkdirp'));
const write     = Promise.promisify(require('write-file-atomic'));


const methods = [
  'status',
  'config',
  'execute',
  'execute_shadow',
  'reindex_start',
  'reindex_done',
  'reindex_abort'
];


function Server(root) {
  // make sure root is always an absolute path
  this.root = path.resolve(root);

  // State structure:
  //
  //  - active      (Number)  - active node id (1 or 2)
  //  - initialized (Boolean) - whether active node is configured or not
  //  - reindex     (Boolean) - whether shadow node is configured or not
  //
  this.state = null;
  this.state_file = path.join(this.root, 'state.json');

  // http server
  this.http = null;

  // daemons
  this.active = null;
  this.shadow = null;
}


Server.prototype.start = Promise.coroutine(function* (listen_url) {
  try {
    this.state = JSON.parse(yield readFile(this.state_file, 'utf8'));

    assert(_.isPlainObject(this.state));
  } catch (err) {
    this.state = { active: 1, initialized: false, reindex: false };

    // make sure it's writable, avoids unreachable directories and such
    yield mkdirp(this.root);
    yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');
  }

  this.active = new Daemon(this.__get_daemon_path__(true));
  this.shadow = new Daemon(this.__get_daemon_path__(false));

  if (this.state.initialized) {
    try {
      yield this.active.start();
    } catch (err) {
      if (err.code === 'EBADCONFIG') {
        // If config file doesn't exist or invalid, mark the server
        // as uninitialized (so it'll receive new config from nodeca);
        // it could happen if someone manually removes nodeX folder
        this.state.initialized = false;
        yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');
      } // otherwise ignore the error (it'll try to start server next time)
    }
  }

  if (this.state.reindex) {
    try {
      yield this.shadow.start();
    } catch (err) {
      if (err.code === 'EBADCONFIG') {
        // If config file doesn't exist or invalid, stop reindex;
        // it could happen if someone manually removes nodeX folder
        this.state.reindex = false;
        yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');
      } // otherwise ignore the error (it'll try to start server next time)
    }
  }

  this.http = http.createServer((req, res) => {
    Promise.resolve().then(() => {
      assert.equal(req.method, 'POST', 'Method not supported, use POST');
    }).then(() => new Promise((resolve, reject) => {
      //
      // Buffer all incoming data (arbitrarily large amount), then
      // parse it all at once. No length checks because we don't expect
      // this server to be receiving connections from untrusted sources.
      //
      let buffers = [];

      req.on('data', d => buffers.push(d));

      req.on('end', () => resolve(Buffer.concat(buffers)));

      req.on('error', err => reject(err));
    })).then(buf => {
      let data = JSON.parse(buf.toString('utf8'));

      assert(_.has(data, 'method'), "'method' is required");
      assert.notEqual(methods.indexOf(data.method), -1, 'No such rpc method');

      return this[data.method].apply(this, data.args || []);
    }).then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result }) + '\n');
    }, err => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: serialize(err) }) + '\n');
    });
  });

  let url_parts = url.parse(listen_url);

  let wait_for_server = new Promise((resolve, reject) => {
    let on_listen, on_error;

    on_listen = () => {
      this.http.removeListener('listening', on_listen);
      this.http.removeListener('error', on_error);
      resolve();
    };

    on_error = err => {
      this.http.removeListener('listening', on_listen);
      this.http.removeListener('error', on_error);
      reject(err);
    };

    this.http.once('listening', on_listen);
    this.http.once('error', on_error);

    this.http.listen(url_parts.port, url_parts.hostname);
  });

  try {
    yield wait_for_server;
  } catch (err) {
    // if server is failed to start (it's the only error that happens in this
    // function), stop the server and re-throw the original error
    try { yield this.stop(); } catch (__) {}
    throw err;
  }
});


Server.prototype.stop = Promise.coroutine(function* () {
  yield Promise.map([ this.active, this.shadow ], daemon => daemon && daemon.stop());

  if (this.http) {
    yield Promise.fromCallback(callback => this.http.close(callback));
  }
});


Server.prototype.status = function () {
  return Promise.resolve({ initialized: !!this.state.initialized });
};


Server.prototype.config = Promise.coroutine(function* (config) {
  if (this.state.initialized) {
    throw new Error('Server is already configured');
  }

  this.state.active = 1;
  this.state.initialized = true;

  let daemon_path = this.__get_daemon_path__(true);

  yield mkdirp(daemon_path);
  yield write(path.join(daemon_path, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');

  this.active = new Daemon(daemon_path);
  yield this.active.start();

  return { ok: 'config written' };
});


Server.prototype.reindex_start = Promise.coroutine(function* (config) {
  // if it's already started, restart it silently
  if (this.shadow) {
    yield this.shadow.destroy();
    this.shadow = null;
  }

  this.state.reindex = true;

  this.shadow = new Daemon(this.__get_daemon_path__(false));

  yield this.shadow.create(config);

  yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');

  return { ok: 're-index started' };
});


Server.prototype.reindex_done = Promise.coroutine(function* () {
  if (!this.state.reindex) {
    return { ok: 're-index finished' };
  }

  let old_active = this.active;

  this.state.reindex = false;

  this.active = this.shadow;
  this.shadow = null;

  /* eslint-disable no-bitwise */
  this.state.active = 3 ^ (this.state.active || 1);

  yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');

  if (old_active) {
    yield old_active.destroy();
  }

  return { ok: 're-index finished' };
});


Server.prototype.reindex_abort = Promise.coroutine(function* () {
  if (!this.state.reindex) {
    return { ok: 're-index aborted' };
  }

  if (this.shadow) {
    yield this.shadow.destroy();
    this.shadow = null;
  }

  this.state.reindex = false;

  yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');

  return { ok: 're-index aborted' };
});


// Search query (starts with SELECT or SHOW):
//  - execute only on `active` node
//  - return result from `active` node
//
// Update query:
//  - execute on both `active` and `shadow` nodes
//  - return result from `shadow` node
//
Server.prototype.execute = Promise.coroutine(function* (queries, args) {
  let first_query = Array.isArray(queries) ?
                    (Array.isArray(queries[0]) ? queries[0][0] : queries[0]) :
                    queries;

  if (first_query.match(/^(SELECT|SHOW)\s/i)) {
    return this.active.execute(queries, args);
  }

  let daemons = [];

  if (this.state.reindex) {
    daemons.push(this.shadow);
  }

  daemons.push(this.active);

  let results = yield Promise.map(daemons.filter(Boolean), (daemon, idx) => {
    if (!daemon) throw new Error('Daemon is not available');

    let promise = daemon.execute(queries, args);

    // only handle errors on the shadow instance if writing to both
    if (idx !== 0) promise = promise.catch(() => {});

    return promise;
  });

  return results[0] ? results[0] : null;
});


// Execute update query on `shadow` node
//
Server.prototype.execute_shadow = function (queries, args) {
  // happens if reindex is cancelled, but more data is coming afterwards
  if (!this.shadow) throw new Error('Daemon is not available');

  return this.shadow.execute(queries, args);
};


// Returns path to daemon root directory,
//  - for active node it's `node1` or `node2` depending on `state.active`
//  - for shadow node it's the opposite (`node2` or `node1` respectively)
//
Server.prototype.__get_daemon_path__ = function (is_active) {
  /* eslint-disable no-bitwise */
  let daemon_id = is_active ?
                  (this.state.active || 1) :
                  (3 ^ (this.state.active || 1));

  return path.join(this.root, 'node' + daemon_id);
};


module.exports = Server;
module.exports.methods = methods;
