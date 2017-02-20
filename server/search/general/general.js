// General search placeholder page, shows search input only;
// it doesn't return any results to prevent heavy load from bots
//

'use strict';

const _           = require('lodash');
const querystring = require('querystring');

const sort_types   = [ 'date', 'rel' ];
const period_types = [ '0', '7', '30', '365' ];


module.exports = function (N, apiPath) {
  N.validate(apiPath, {
    $query: { type: 'string', required: false }
  });

  N.wire.on(apiPath, function search_general(env) {
    let menu = _.get(N.config, 'search.general.menu', {});
    let content_types = Object.keys(menu)
                         .sort((a, b) => (menu[a].priority || 100) - (menu[b].priority || 100));
    let type = content_types[0];

    env.res.head.title = env.t('title');
    env.res.head.robots = 'noindex,nofollow';

    if (env.params.$query) {
      let query = querystring.parse(env.params.$query);

      // validate content type
      if (query.type && content_types.indexOf(query.type) === -1) {
        throw N.io.BAD_REQUEST;
      }

      type = query.type;

      env.res.query  = query.query;
      env.res.sort   = query.sort;
      env.res.period = query.period;
    }

    env.res.type          = type;
    env.res.sort_types    = sort_types;
    env.res.period_types  = period_types;
    env.res.content_types = content_types;

    // an amount of search results loaded at once,
    // it is expected to be overriden for different content types
    env.res.items_per_page = 40;
  });
};
