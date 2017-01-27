// Escape user-submitted search query to use inside MATCH(...) operator
//
// Character list is taken from:
// http://sphinxsearch.com/forum/view.html?id=10003
//
// Entire query is converted to lowercase to avoid collisions with special
// keywords like "PARAGRAPH"
//

'use strict';


module.exports = function sphinx_escape(query) {
  return query.replace(/([\\()|\-!@~"&/^$=])/g, '\\$1').toLowerCase();
};
