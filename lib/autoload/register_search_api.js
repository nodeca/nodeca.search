// Register search API methods
//

'use strict';


const needle  = require('needle');
const methods = require('nodeca.search/lib/server').methods;


module.exports = function (N) {

  N.wire.on('init:models', function search_api_init(N) {

    let endpoint = N.config?.search?.api_endpoint || 'http://localhost:9304';

    function search_rpc(method, args) {
      return needle('post', endpoint, { method, args }, {
        open_timeout: 3000,
        response_timeout: 5000,
        read_timeout: 5000,
        json: true,
        parse_response: 'json'
      }).then(res => {
        if (res.statusCode !== 200) {
          throw new Error(`Wrong HTTP response code: ${res.statusCode}`);
        }

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
