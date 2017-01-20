// General search
//

'use strict';

const querystring = require('querystring');


module.exports = function (N, apiPath) {
  N.validate(apiPath, {
    $query: { type: 'string', required: false }
  });

  N.wire.on(apiPath, function search_general(env) {
    env.res.head.title = env.t('title');

    if (env.params.$query) {
      let query = querystring.parse(env.params.$query);

      env.res.search_query = query.query;
    }
  });
};
