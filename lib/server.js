// Public search interface
//

'use strict';

const _         = require('lodash');
const assert    = require('assert');
const Promise   = require('bluebird');
const http      = require('http');
const mysql     = require('mysql2');
const fs        = require('mz/fs');
const path      = require('path');
const serialize = require('serialize-error');
const url       = require('url');
const Daemon    = require('./daemon');
const mkdirp    = Promise.promisify(require('mkdirp'));
const rimraf    = Promise.promisify(require('rimraf'));
const write     = Promise.promisify(require('write-file-atomic'));


const methods = [
  'status',
  'config',
  'do',
  'execute',
  'execute_shadow',
  'reindex_start',
  'reindex_done',
  'reindex_abort'
];


// emulate prepared statements because sphinx doesn't support those
function prepare_query(query, args) {
  if (!args) args = [];

  let i = 0;

  return query.replace(/\?/g, () => mysql.escape(args[i++]));
}


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
    this.state = JSON.parse(yield fs.readFile(this.state_file, 'utf8'));

    assert(_.isPlainObject(this.state));
  } catch (err) {
    this.state = { active: 1, initialized: false, reindex: false };

    // make sure it's writable, avoids unreachable directories and such
    yield mkdirp(this.root);
    yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');
  }

  if (this.state.initialized) {
    this.active = new Daemon(this.get_daemon_path(true));
  }

  if (this.state.reindex) {
    this.shadow = new Daemon(this.get_daemon_path(false));
  }

  yield Promise.map([ this.active, this.shadow ], daemon => daemon && daemon.start());

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
      res.end(JSON.stringify(result) + '\n');
    }, err => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: serialize(err) }) + '\n');
    });
  });

  let url_parts = url.parse(listen_url);

  yield Promise.fromCallback(callback => this.http.listen(url_parts.port, url_parts.hostname, callback));
});


// Returns path to daemon root directory,
//  - for active node it's `node1` or `node2` depending on `state.active`
//  - for shadow node it's the opposite (`node2` or `node1` respectively)
//
Server.prototype.get_daemon_path = function (is_active) {
  /* eslint-disable no-bitwise */
  let daemon_id = is_active ?
                  (this.state.active || 1) :
                  (3 ^ (this.state.active || 1));

  return path.join(this.root, 'node' + daemon_id);
};


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

  yield mkdirp(this.get_daemon_path(true));
  yield write(path.join(this.get_daemon_path(true), 'config.json'), JSON.stringify(config, null, 2) + '\n');
  yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');

  this.active = new Daemon(this.get_daemon_path(true));
  yield this.active.start();

  return { ok: 'config written' };
});


Server.prototype.reindex_start = Promise.coroutine(function* (config) {
  // if it's already started, restart it silently

  if (this.shadow) {
    yield this.shadow.stop();
    this.shadow = null;
  }

  // remove old shadow daemon directory
  yield rimraf(this.get_daemon_path(false));

  this.state.reindex = true;

  yield mkdirp(this.get_daemon_path(false));
  yield write(path.join(this.get_daemon_path(false), 'config.json'), JSON.stringify(config, null, 2) + '\n');
  yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');

  this.shadow = new Daemon(this.get_daemon_path(false));
  yield this.shadow.start();

  return { ok: 're-index started' };
});


Server.prototype.reindex_done = Promise.coroutine(function* () {
  if (!this.state.reindex) {
    return { ok: 're-index finished' };
  }

  let old_active = this.active;
  let old_path = this.get_daemon_path(true);

  /* eslint-disable no-bitwise */
  this.active = this.shadow;
  this.state.active = 3 ^ (this.state.active || 1);

  yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');

  if (old_active) {
    yield old_active.stop();
  }

  yield rimraf(old_path);

  return { ok: 're-index finished' };
});


Server.prototype.reindex_abort = Promise.coroutine(function* () {
  if (!this.state.reindex) {
    return { ok: 're-index aborted' };
  }

  if (this.shadow) {
    yield this.shadow.stop();
    this.shadow = null;
  }

  // remove shadow daemon directory
  yield rimraf(this.get_daemon_path(false));

  this.state.reindex = false;

  yield write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');

  return { ok: 're-index aborted' };
});


// Execute search query, only on `active` node with `count: true`
//
Server.prototype.do = function (query, args) {
  return this.active.execute(prepare_query(query, args), true);
};


// Execute update query on both `active` and `shadow` nodes,
// return result from shadow node.
//
Server.prototype.execute = Promise.coroutine(function* (query, args) {
  let daemons = [];

  if (this.state.reindex) {
    daemons.push(this.shadow);
  }

  daemons.push(this.active);

  let str = prepare_query(query, args);

  let results = yield Promise.map(daemons.filter(Boolean), (daemon, idx) => {
    let promise = daemon.execute(str, query.count);

    // only handle errors on the shadow instance if writing to both
    if (idx !== 0) promise = promise.catch(() => {});

    return promise;
  });

  return results[0] ? results[0] : null;
});


// Execute update query on `shadow` node
//
Server.prototype.execute_shadow = function (query, args) {
  return this.shadow.execute(prepare_query(query, args));
};


module.exports = Server;
module.exports.methods = methods;
