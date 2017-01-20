// Search page
//

'use strict';

let querystring = require('querystring');


// Execute search if it's defined in query
//
N.wire.on('navigate.done:' + module.apiPath, function page_init(data) {
  let parsed = querystring.parse(data.params.$query);

  if (parsed.query) {
    N.io.rpc('search.general.list', parsed).then(function (res) {
      $('.search-general__results').replaceWith($(N.runtime.render(module.apiPath + '.results', res)));
    }).catch(err => {
      N.wire.emit('error', err);
    });
  }
});


// Perform search after user clicks on "search" button
//
N.wire.on(module.apiPath + ':search', function do_search(data) {
  // TODO: can't use "apiPath" syntax for navigate.to 'cause it loads data
  //       with $query in it incorrectly
  return N.wire.emit('navigate.to',
    N.router.linkTo(module.apiPath, { $query: { query: data.fields.query } })
  );
});
