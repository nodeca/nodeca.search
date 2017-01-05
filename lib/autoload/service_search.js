// Launch search daemon if needed, send config to it
//

'use strict';

const _       = require('lodash');
const cluster = require('cluster');
const path    = require('path');
const Server  = require('nodeca.search/lib/server');


module.exports = function (N) {

  let server;

  N.wire.after('init:models', function* search_daemon_init(N) {
    if (!cluster.isMaster) return;

    let endpoint = _.get(N.config, 'search.api_endpoint', 'http://localhost:9304/').replace(/\/$/, '');

    if (N.config.search.is_local) {
      server = new Server(path.resolve(N.mainApp.root, N.config.search.base));

      yield server.start(endpoint);
    }

    try {
      let status = yield N.search.status();

      if (!status.initialized) {
        yield N.search.config(N.config.search);
      }
    } catch (err) {
      N.logger.error("Can't initialize search: " + (err.message || err));
    }
  });


  N.wire.on([ 'exit.shutdown', 'exit.terminate' ], { ensure: true, parallel: true }, function close_search() {
    if (!server) return;

    return server.stop();
  });
};
