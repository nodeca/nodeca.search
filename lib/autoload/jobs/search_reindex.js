
'use strict';

const Queue    = require('idoit');
const inherits = require('util').inherits;


module.exports = function (N) {
  N.wire.on('init:jobs', function* register_search_reindex() {
    let reindex_tasks = [];

    yield N.wire.emit('internal:search.reindex.tasklist', reindex_tasks);

    if (!N.config.cron || !N.config.cron.search_reindex) {
      return new Error('No config defined for cron task "search_reindex"');
    }

    function ReindexTemplate(queue, args) {
      let tasks = [];

      tasks.push(N.queue.search_reindex_start());

      reindex_tasks.forEach(name => {
        if (args && args.cutoff) {
          let cutoff_ts = Date.now() - args.cutoff * 24 * 60 * 60 * 1000;
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

      Queue.ChainTemplate.call(this, queue, tasks);
    }

    inherits(ReindexTemplate, Queue.ChainTemplate);

    ReindexTemplate.serializableFields = Queue.ChainTemplate.serializableFields;

    ReindexTemplate.extend = function (options) {
      class T extends ReindexTemplate {}

      Object.assign(T.prototype, options);

      return T;
    };


    N.queue.registerTask({
      name: 'search_reindex',
      pool: 'hard',
      baseClass: ReindexTemplate,
      cron: N.config.cron.search_reindex,
      taskID: () => 'search_reindex'
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
