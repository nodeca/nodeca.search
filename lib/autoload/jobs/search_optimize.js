
'use strict';


module.exports = function (N) {
  N.wire.on('init:jobs', function register_search_optimize() {
    N.queue.registerTask({
      name: 'search_optimize',
      pool: 'hard',
      taskID: () => 'search_optimize',
      async process() {
        let tables = await N.search.execute_shadow('SHOW TABLES');

        await N.search.execute_shadow(
          tables.map(table => `FLUSH RTINDEX ${table.Index}`)
        );

        await N.search.execute_shadow(
          tables.map(table => `OPTIMIZE INDEX ${table.Index}`)
        );
      }
    });
  });
};
