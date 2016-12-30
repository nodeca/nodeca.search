// Start re-index
//

'use strict';


module.exports = function (N, apiPath) {
  N.validate(apiPath, {});

  N.wire.on(apiPath, function* search_reindex_start() {
    yield N.queue.search_reindex().run();
  });
};
