// RPC method used to fetch results and render tabs
//

'use strict';

const _       = require('lodash');
const Promise = require('bluebird');

const sort_types   = [ 'date', 'rel' ];
const period_types = [ '0', '7', '30', '365' ];


module.exports = function (N, apiPath) {
  N.validate(apiPath, {
    properties: {
      query:  { type: 'string',  required: true },
      type:   { type: 'string',  required: false },
      skip:   { type: 'integer', required: true, minimum: 0 },
      limit:  { type: 'integer', required: true, minimum: 0, maximum: 50 },
      sort:   { 'enum': sort_types,   required: false },
      period: { 'enum': period_types, required: false }
    },
    additionalProperties: true
  });


  N.wire.on(apiPath, function* search_execute(env) {
    let menu = _.get(N.config, 'search.general.menu', {});
    let content_types = Object.keys(menu)
                         .sort((a, b) => (menu[a].priority || 100) - (menu[b].priority || 100));

    // if type is not specified, select first one
    if (!env.params.type) {
      env.params.type = content_types[0];
    }

    // validate content type
    if (content_types.indexOf(env.params.type) === -1) {
      throw N.io.BAD_REQUEST;
    }

    // check query length because 1-character requests consume too much resources
    if (env.params.query.trim().length < 2) {
      throw {
        code: N.io.CLIENT_ERROR,
        message: env.t('err_query_too_short')
      };
    }

    let counts = {};

    let search_env = {
      params: {
        user_info: env.user_info,
        query:     env.params.query,
        period:    env.params.period ? Number(env.params.period) : Number(period_types[0]),
        sort:      env.params.sort ? env.params.sort : sort_types[0],
        limit:     env.params.limit,
        skip:      env.params.skip
      }
    };

    yield N.wire.emit('internal:search.general.' + env.params.type, search_env);

    env.res.results = search_env.results;
    env.data.users = (env.res.users || []).concat(search_env.users);

    // set result count for current tab
    counts[env.params.type] = search_env.count;

    // calculate result counts for other tabs (first page only)
    if (env.params.skip === 0) {
      let other_tabs = _.without(content_types, env.params.type);

      yield Promise.map(other_tabs, Promise.coroutine(function* (type) {
        let search_env = {
          params: {
            user_info: env.user_info,
            query:     env.params.query,
            period:    env.params.period ? Number(env.params.period) : Number(period_types[0]),
            sort:      env.params.sort ? env.params.sort : sort_types[0],
            limit:     0,
            skip:      0
          }
        };

        yield N.wire.emit('internal:search.general.' + type, search_env);

        counts[type] = search_env.count;
      }));

      env.res.tabs = content_types.map(type => ({
        type,
        count: counts[type]
      }));

      env.res.type = env.params.type;
    }
  });
};
