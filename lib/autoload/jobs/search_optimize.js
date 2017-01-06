
'use strict';

const Promise = require('bluebird');


module.exports = function (N) {
  N.wire.on('init:jobs', function register_search_optimize() {
    N.queue.registerTask({
      name: 'search_optimize',
      pool: 'hard',
      taskID: () => 'search_optimize',
      process: Promise.coroutine(function* () {
        //let status = (yield N.search.execute_shadow('SHOW STATUS'))[0];
        //console.log(status);
      })
    });
  });
};
