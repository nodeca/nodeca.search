// Stop re-index
//

'use strict';


module.exports = function (N, apiPath) {
  N.validate(apiPath, {});

  N.wire.on(apiPath, async function search_reindex_stop() {
    await N.queue.cancel('search_reindex');
    await N.search.reindex_abort();
  });
};
