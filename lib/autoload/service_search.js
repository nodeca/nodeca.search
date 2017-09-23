// Launch search daemon if needed, send config to it
//

'use strict';

const _       = require('lodash');
const cluster = require('cluster');
const path    = require('path');
const Server  = require('nodeca.search/lib/server');


module.exports = function (N) {

  let server;

  N.wire.before('init:services', async function search_daemon_init(N) {
    if (!cluster.isMaster) return;

    let endpoint = _.get(N.config, 'search.api_endpoint', 'http://localhost:9304/').replace(/\/$/, '');

    if (N.config.search.is_local) {
      server = new Server(path.resolve(N.mainApp.root, N.config.search.base));

      await server.start(endpoint);
    }

    try {
      let status = await N.search.status();

      if (!status.initialized) {
        await N.search.config(N.config.search);
      }
    } catch (err) {
      N.logger.error("Can't initialize search: " + (err.message || err));
    }
  });
};
