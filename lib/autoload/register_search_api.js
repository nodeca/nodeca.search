// Register search API methods
//
'use strict';


const methods = [
  'reindex_start',
  'reindex_done',
  'reindex_abort',
  'exec',
  'exec_stale'
];


module.exports = function (N) {

  function search_rpc() {
  }

  N.search = {};

  methods.forEach(method => {
    N.search[method] = function (...args) {
      args.unshift(method);
      return search_rpc(...args);
    };
  });

};
