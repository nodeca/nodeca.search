// Show/hide search bar
//

'use strict';

const _  = require('lodash');


N.wire.on(module.apiPath + ':show', function show_search_bar(data) {
  let container = data.$this.closest('.navbar');

  container.addClass('nav-search-on');
  container.find('.nav-search__input').focus();
});


N.wire.on(module.apiPath + ':hide', function hide_search_bar(data) {
  let container = data.$this.closest('.navbar');

  container.removeClass('nav-search-on');
});


N.wire.on(module.apiPath + ':change_area', function set_search_area(data) {
  let select = data.$this.closest('.input-group-btn').find('.nav-search__select');

  select.text(data.$this.text());
  select.data('method', data.$this.data('method') || null);
  select.data('params', data.$this.data('params') || null);
});


N.wire.on(module.apiPath + ':submit', function submit_search(data) {
  let select = data.$this.find('.nav-search__select');
  let params = _.assign({}, select.data('params'));
  let apiPath = select.data('method') || 'search.general';

  if (data.fields.query) {
    params.query = data.fields.query;
  }

  return N.wire.emit('navigate.to', {
    apiPath,
    params: { $query: params },
    force: true
  });
});
