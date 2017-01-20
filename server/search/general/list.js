// General search
//

'use strict';

const Promise = require('bluebird');


module.exports = function (N, apiPath) {
  N.validate(apiPath, {
    properties: {
      query: { type: 'string', required: true },
      type:  { type: 'string', required: false }
    },
    additionalProperties: true
  });


  N.wire.before(apiPath, { priority: -20 }, function initialize_locals(env) {
    // filled in by external hooks with -10 priority
    env.data.content_types = [];
  });


  N.wire.on(apiPath, function* search_execute(env) {
    // if type is not specified, select first one
    if (!env.params.type) {
      env.params.type = env.data.content_types[0];
    }

    // validate content type
    if (env.data.content_types.indexOf(env.params.type) === -1) {
      throw N.io.BAD_REQUEST;
    }

    let counts = {};

    yield Promise.map(env.data.content_types, Promise.coroutine(function* (type) {
      let search_env = {
        params: Object.assign({ user_info: env.user_info }, env.params)
      };

      yield N.wire.emit('internal:search.general.' + type, search_env);

      counts[type] = search_env.count;
    }));

    env.res.tabs = env.data.content_types.map(type => ({ type, count: counts[type] }));
  });
};
