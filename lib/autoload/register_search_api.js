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
        body: { method, args },
        json: true
      }).then(res => {
        // `res.body` could be:
        //
        // { error:  { name, message, stack } } - in case of errors
        // { result: [ ... ] }                  - result of a sql query
        // { result: { initialized: true }      - for `status` command
        // { result: { ok: 'status message' } } - for `reindex_start`, `reindex_stop`, etc.
        //
        if (res.body.error) {
          let error = new Error(res.body.error.message);

          throw Object.assign(error, res.body.error);
        }

        return res.body.result;
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
