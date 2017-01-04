
'use strict';

const Queue = require('idoit');


module.exports = function (N) {
  N.wire.on('init:jobs', function* register_search_reindex() {
    let last_finished_uid = null;
    let reindex_tasks = [];

    yield N.wire.emit('internal:search.reindex.tasklist', reindex_tasks);

    N.queue.registerTask({
      name: 'search_reindex',
      pool: 'hard',
      baseClass: Queue.ChainTemplate,
      taskID: () => 'search_reindex',
      init() {
        this.__children__ = [];

        this.__children__.push(N.queue.search_reindex_start());

        reindex_tasks.forEach(name => {
          this.__children__.push(N.queue[name]());
        });

        this.__children__.push(N.queue.search_reindex_done(this.uid));
      }
    });


    N.queue.registerTask({
      name: 'search_reindex_start',
      pool: 'hard',
      process: () => N.search.reindex_start(N.config.search)
    });


    N.queue.registerTask({
      name: 'search_reindex_done',
      pool: 'hard',
      process: uid => N.search.reindex_done().then(() => { last_finished_uid = uid; })
    });


    N.queue.on('task:progress:search_reindex', function (task_info) {
      N.live.debounce('admin.search.index.reindex', {
        uid:     task_info.uid,
        current: task_info.progress,
        total:   task_info.total
      });
    });


    N.queue.on('task:end:search_reindex', function (task_info) {
      if (task_info.uid !== last_finished_uid) {
        N.search.reindex_abort();
      }

      N.live.emit('admin.search.index.reindex', {
        uid:      task_info.uid,
        finished: true
      });
    });
  });
};
