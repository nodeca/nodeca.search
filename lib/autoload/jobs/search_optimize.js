
'use strict';

const Promise = require('bluebird');


module.exports = function (N) {
  N.wire.on('init:jobs', function register_search_optimize() {
    N.queue.registerTask({
      name: 'search_optimize',
      pool: 'hard',
      taskID: () => 'search_optimize',
      process: Promise.coroutine(function* () {
        let tables = yield N.search.execute_shadow('SHOW TABLES');

        yield N.search.execute_shadow(
          tables.map(table => `FLUSH RTINDEX ${table.Index}`)
        );

        yield N.search.execute_shadow(
          tables.map(table => `OPTIMIZE INDEX ${table.Index}`)
        );
      })
    });
  });
};
