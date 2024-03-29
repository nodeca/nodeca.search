// Launch search daemon if needed, send config to it
//

'use strict';


const cluster = require('cluster');
//const Server  = require('nodeca.search/lib/server');


module.exports = function (N) {

  N.wire.before('init:services', async function search_daemon_init(N) {
    if (!cluster.isMaster) return;

    let endpoint = N.config?.search?.api_endpoint || 'http://localhost:9304';
    let wait_for_search = Promise.resolve();

    if (N.config.search.is_local) {
      //server = new Server(path.resolve(N.mainApp.root, N.config.search.base));
      //await server.start(endpoint);

      cluster.setupMaster({
        exec: require.resolve('nodeca.search/server.js'),
        args: [ '--listen', new URL(endpoint).host ]
      });
      let server = cluster.fork();

      wait_for_search = new Promise(resolve => {
        server.on('message', msg => {
          if (msg === 'ready') resolve();
        });
      });
    }

    // don't wait for search server to start
    wait_for_search.then(async () => {
      let status = await N.search.status();

      if (!status.initialized) {
        await N.search.config(N.config.search);
      }
    }).catch(err => N.logger.error("Can't initialize search: " + (err.message || err)));
  });
};
