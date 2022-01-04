// Public search interface
//

'use strict';


const assert        = require('assert');
const http          = require('http');
const path          = require('path');
const serialize     = require('serialize-error').serializeError;
const url           = require('url');
const Daemon        = require('./daemon');
const { promisify } = require('util');
const mkdirp        = require('mkdirp');
const write         = promisify(require('write-file-atomic'));
const readFile      = require('fs/promises').readFile;
const log4js        = require('log4js');


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
  this.logger = log4js.getLogger('search');

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


Server.prototype.start = async function (listen_url) {
  await this.__restore_state__();

  this.active = this.__create_daemon__(true);
  this.shadow = this.__create_daemon__(false);

  if (this.state.initialized) {
    try {
      await this.active.start();
    } catch (err) {
      if (err.code === 'EBADCONFIG') {
        // If config file doesn't exist or invalid, mark the server
        // as uninitialized (so it'll receive new config from nodeca);
        // it could happen if someone manually removes nodeX folder
        this.state.initialized = false;
        await this.__save_state__();
      } // otherwise ignore the error (it'll try to start server next time)

      this.logger.error(`Cannot start active node during init: ${err.message || err}`);
    }
  }

  if (this.state.reindex) {
    try {
      await this.shadow.start();
    } catch (err) {
      if (err.code === 'EBADCONFIG') {
        // If config file doesn't exist or invalid, stop reindex;
        // it could happen if someone manually removes nodeX folder
        this.state.reindex = false;
        await this.__save_state__();
      } // otherwise ignore the error (it'll try to start server next time)

      this.logger.error(`Cannot start shadow node during init: ${err.message || err}`);
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

      assert.ok(data?.method, "'method' is required");
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
      this.logger.info(`Search HTTP server is started on http://${url_parts.hostname}:${url_parts.port}/`);
      resolve();
    };

    on_error = err => {
      this.http.removeListener('listening', on_listen);
      this.http.removeListener('error', on_error);
      this.logger.fatal('Cannot start search HTTP server: ' + (err.stack || err));
      reject(err);
    };

    this.http.once('listening', on_listen);
    this.http.once('error', on_error);

    this.http.listen(url_parts.port, url_parts.hostname);
  });

  try {
    await wait_for_server;
  } catch (err) {
    // if server is failed to start (it's the only error that happens in this
    // function), stop the server and re-throw the original error
    try { await this.stop(); } catch (__) {}
    throw err;
  }
};


Server.prototype.stop = async function () {
  await Promise.all([
    this.active && this.active.stop(),
    this.shadow && this.shadow.stop()
  ]);

  if (this.http) {
    await new Promise((resolve, reject) => {
      this.http.close(err => (err ? reject(err) : resolve()));
    });
  }
};


Server.prototype.status = function () {
  return Promise.resolve({ initialized: !!this.state.initialized });
};


Server.prototype.config = async function (config) {
  this.logger.info('Receiving config');

  if (this.state.initialized) {
    this.logger.warn('Server is already configured');
    throw new Error('Server is already configured');
  }

  this.state.active = 1;
  this.state.initialized = true;

  let daemon = this.__create_daemon__(true);

  await mkdirp(daemon.root);
  await write(path.join(daemon.root, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  await this.__save_state__();

  this.active = daemon;

  try {
    await this.active.start();
  } catch (err) {
    this.logger.error(`Cannot start active node after configure: ${err.message || err}`);
    throw err;
  }

  return { ok: 'config written' };
};


Server.prototype.reindex_start = async function (config) {
  // if it's already started, restart it silently
  if (this.shadow) {
    await this.shadow.destroy();
    this.shadow = null;
  }

  this.state.reindex = true;

  this.shadow = this.__create_daemon__(false);
  await this.shadow.create(config);

  await this.__save_state__();

  return { ok: 're-index started' };
};


Server.prototype.reindex_done = async function () {
  if (!this.state.reindex) {
    return { ok: 're-index finished' };
  }

  let old_active = this.active;

  this.state.reindex = false;

  this.active.log_prefix = `node${this.active.id} (unused): `;
  this.active = this.shadow;
  this.logger.info(`node${this.active.id}: shadow -> active`);
  this.active.log_prefix = `node${this.active.id} (active): `;

  this.state.active = this.active.id;
  this.shadow = null;

  await this.__save_state__();

  if (old_active) {
    await old_active.destroy();
  }

  return { ok: 're-index finished' };
};


Server.prototype.reindex_abort = async function () {
  if (!this.state.reindex) {
    return { ok: 're-index aborted' };
  }

  if (this.shadow) {
    await this.shadow.destroy();
    this.shadow = null;
  }

  this.state.reindex = false;

  await this.__save_state__();

  return { ok: 're-index aborted' };
};


// Search query (starts with SELECT or SHOW):
//  - execute only on `active` node
//  - return result from `active` node
//
// Update query:
//  - execute on both `active` and `shadow` nodes
//  - return result from `shadow` node
//
Server.prototype.execute = async function (queries, args) {
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

  let results = await Promise.all(daemons.filter(Boolean).map((daemon, idx) => {
    if (!daemon) throw new Error('Daemon is not available');

    let promise = daemon.execute(queries, args);

    // only handle errors on the shadow instance if writing to both
    if (idx !== 0) promise = promise.catch(() => {});

    return promise;
  }));

  return results[0] ?? null;
};


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
Server.prototype.__get_daemon_path__ = function (id) {
  return path.join(this.root, `node${id}`);
};


Server.prototype.__get_daemon_id__ = function (is_active) {
  /* eslint-disable no-bitwise */
  return is_active ?
         (this.state.active || 1) :
         (3 ^ (this.state.active || 1));
};


Server.prototype.__save_state__ = async function () {
  await write(this.state_file, JSON.stringify(this.state, null, 2) + '\n');
  this.logger.info(`Save state: ${Object.entries(this.state).map(([ k, v ]) => `${k}=${v}`).join(', ')}`);
};


Server.prototype.__restore_state__ = async function () {
  try {
    this.state = JSON.parse(await readFile(this.state_file, 'utf8'));

    assert.strictEqual(Object.prototype.toString.call(this.state), '[object Object]');
    this.logger.info(`Load state: ${Object.entries(this.state).map(([ k, v ]) => `${k}=${v}`).join(', ')}`);
  } catch (err) {
    this.logger.warn('No existing state found (first run?)');
    this.state = { active: 1, initialized: false, reindex: false };

    // make sure it's writable, avoids unreachable directories and such
    await mkdirp(this.root);
    await this.__save_state__();
  }
};


Server.prototype.__create_daemon__ = function (is_active) {
  let id = this.__get_daemon_id__(is_active);

  let daemon = new Daemon({
    root: this.__get_daemon_path__(id),
    id
  });
  daemon.log_prefix = `node${id} (${is_active ? 'active' : 'shadow'}): `;

  return daemon;
};


module.exports = Server;
module.exports.methods = methods;
