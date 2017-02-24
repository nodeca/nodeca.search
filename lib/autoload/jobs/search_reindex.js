
'use strict';


const Promise  = require('bluebird');
const Queue    = require('idoit');


module.exports = function (N) {
  N.wire.on('init:jobs', function register_search_reindex() {

    if (!N.config.cron || !N.config.cron.search_reindex) {
      return new Error('No config defined for cron task "search_reindex"');
    }

    N.queue.registerTask({
      name: 'search_reindex',
      pool: 'hard',
      baseClass: Queue.ChainTemplate,
      cron: N.config.cron.search_reindex,
      taskID: () => 'search_reindex',
      init: Promise.coroutine(function* () {
        let task_names = [];
        let tasks = [];

        yield N.wire.emit('internal:search.reindex.tasklist', task_names);

        tasks.push(N.queue.search_reindex_start());

        task_names.forEach(name => {
          if (this.args[0] && this.args[0].cutoff) {
            let cutoff_ts = Date.now() - this.args[0].cutoff * 24 * 60 * 60 * 1000;
            let cutoff_objectid = Math.floor(cutoff_ts / 1000).toString(16) + '0000000000000000';

            tasks.push(N.queue[name](cutoff_objectid));
          } else {
            tasks.push(N.queue[name]());
          }
        });

        if (N.config.search.optimize) {
          tasks.push(N.queue.search_optimize());
        }

        tasks.push(N.queue.search_reindex_done());

        this.__children_to_init__ = tasks;
      })
    });


    N.queue.registerTask({
      name: 'search_reindex_start',
      pool: 'hard',
      process: () => N.search.reindex_start(N.config.search)
    });


    N.queue.registerTask({
      name: 'search_reindex_done',
      pool: 'hard',
      process: () => N.search.reindex_done()
    });


    N.queue.on('task:progress:search_reindex', function (task_info) {
      N.live.debounce('admin.search.index.reindex', {
        uid:     task_info.uid,
        current: task_info.progress,
        total:   task_info.total
      });
    });


    N.queue.on('task:end:search_reindex', function (task_info) {
      N.live.emit('admin.search.index.reindex', {
        uid:      task_info.uid,
        finished: true
      });
    });
  });
};
