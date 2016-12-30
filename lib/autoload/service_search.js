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

    let send_config = true;

    let endpoint = _.get(N.config, 'search.api_endpoint', 'http://localhost:9304/').replace(/\/$/, '');

    if (N.config.search.is_local) {
      try {
        server = new Server(path.resolve(N.mainApp.root, N.config.search.base));

        yield server.start(endpoint);
      } catch (err) {
        // don't stop main server if searchd can't be started, just log it
        N.logger.error("Can't start search daemon: " + (err.message || err));
        send_config = false;
      }
    }

    if (send_config) {
      try {
        let status = yield N.search.status();

        if (!status.initialized) {
          yield N.search.config(N.config.search);
        }
      } catch (err) {
        N.logger.error("Can't initialize search: " + (err.message || err));
      }
    }
  });


  N.wire.on('exit.shutdown', { ensure: true, parallel: true }, function close_search() {
    if (!server) return;

    return server.stop();
  });
};
