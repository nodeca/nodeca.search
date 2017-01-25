// Disallow bots from accessing search methods
//

'use strict';


module.exports = function (N) {
  N.wire.after('server:common.robots', function robots_add_search(env) {
    env.body += 'Disallow: /search\n';
  });
};
