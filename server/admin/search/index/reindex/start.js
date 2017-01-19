// Start re-index
//

'use strict';


module.exports = function (N, apiPath) {
  N.validate(apiPath, {
    cutoff: { type: 'integer', minimum: 0 }
  });

  N.wire.on(apiPath, function* search_reindex_start(env) {
    let params = {};

    if (env.params.cutoff) params.cutoff = env.params.cutoff;

    yield N.queue.search_reindex(params).run();
  });
};
