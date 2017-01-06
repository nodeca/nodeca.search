// Register search API methods
//

'use strict';

const _       = require('lodash');
const got     = require('got');
const methods = require('nodeca.search/lib/server').methods;


module.exports = function (N) {

  N.wire.on('init:models', function search_api_init(N) {

    let endpoint = _.get(N.config, 'search.api_endpoint', 'http://localhost:9304/');

    function search_rpc(method, args) {
      return got.post(endpoint, {
        timeout: 30000,
        retries: 0,
        body: JSON.stringify({ method, args }),
        json: true
      }).then(res => {
        // throws serialized error with { name, message, stack }
        if (res.body.error) throw res.body.error;

        return res.body;
      });
    }

    N.search = {};

    methods.forEach(method => {
      N.search[method] = function (...args) {
        return search_rpc(method, args);
      };
    });
  });
};
