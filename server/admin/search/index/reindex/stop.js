// Stop re-index
//

'use strict';


module.exports = function (N, apiPath) {
  N.validate(apiPath, {});

  N.wire.on(apiPath, function* search_reindex_stop() {
    yield N.queue.cancel('search_reindex');
  });
};
