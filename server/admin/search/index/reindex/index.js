// Add a widget displaying reindex progress
//

'use strict';


module.exports = function (N) {
  N.wire.after('server:admin.search.index', { priority: 50 }, function* search_reindex_widget(env) {
    let task = yield N.queue.getTask('search_reindex');
    let task_info = {};

    if (task && task.state !== 'finished') {
      task_info = {
        current: task.progress,
        total:   task.total
      };
    }

    env.res.blocks.push({ name: 'reindex', task_info });
  });
};
