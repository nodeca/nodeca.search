// Search page
//

'use strict';

const _           = require('lodash');
const querystring = require('querystring');

// An amount of search results to load in one request
const LOAD_COUNT = 30;

// List of the used key names in query string
const query_fields = [ 'query', 'type', 'sort', 'period' ];

// - search:
//   - query:            search query
//   - type:             search type (forum_posts, forum_topics, etc.)
//   - sort:             sort type (`weight` or `ts`)
//   - period:           period in days
// - reached_end:        true if no more results exist below last loaded result
// - next_loading_start: time when current xhr request for the next page is started
// - bottom_marker:      offset of the last loaded result
//
let pageState = {};


// Execute search if it's defined in query
//
N.wire.on('navigate.done:' + module.apiPath, function page_init(data) {
  let parsed = querystring.parse(data.params.$query);

  pageState.search             = _.pick(parsed, query_fields);
  pageState.reached_end        = false;
  pageState.next_loading_start = 0;
  pageState.bottom_marker      = 0;

  if (parsed.query) {
    N.io.rpc('search.general.results', _.assign({}, pageState.search, {
      skip:   0,
      limit:  LOAD_COUNT
    })).then(function (res) {
      res.tabs.forEach(tab => {
        tab.link = N.router.linkTo('search.general', {
          $query: _.assign({}, pageState.search, { type: tab.type })
        });
      });

      return N.wire.emit('navigate.update', {
        $: $(N.runtime.render(module.apiPath + '.results', res)),
        locals: res,
        $replace: $('.search-general__results')
      });
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
    N.router.linkTo(module.apiPath, { $query: data.fields })
  );
});


// Fetch more results when user scrolls down
//
N.wire.on(module.apiPath + ':load_next', function load_next() {
  // TODO
});
