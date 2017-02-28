// Show/hide search bar
//

'use strict';

const _  = require('lodash');


// Hide search bar if user presses Escape key,
// and focus is inside search bar
//
function keydown_handler(event) {
  if (event.which !== 27 /* ESC */) return;

  event.preventDefault();
  event.stopPropagation();

  /* eslint-disable no-use-before-define */
  hide_search_bar();
}


// Click inside form, need to stop propagation of this event
// to global handlers
//
function click_inside_form_handler(event) {
  event.stopPropagation();
}


// Hide search bar if user clicks anywhere outside of it
//
function click_outside_form_handler(event) {
  if (event.which === 3 /* right mouse button */) return;

  hide_search_bar();
}


// Show search bar
//
function show_search_bar() {
  $('.navbar').addClass('nav-search-on');
  $('.nav-search__input').focus();

  $(document).on('keydown', '.nav-search__form', keydown_handler);
  $(document).on('click focusin', '.nav-search__form', click_inside_form_handler);
  $(document).on('click focusin', click_outside_form_handler);
}


// Hide search bar
//
function hide_search_bar() {
  $('.navbar').removeClass('nav-search-on');

  $(document).off('keydown', '.nav-search__form', keydown_handler);
  $(document).off('click focusin', '.nav-search__form', click_inside_form_handler);
  $(document).off('click focusin', click_outside_form_handler);
}


N.wire.on(module.apiPath + ':show', show_search_bar);
N.wire.on(module.apiPath + ':hide', hide_search_bar);


N.wire.on(module.apiPath + ':change_area', function set_search_area(data) {
  let select = data.$this.closest('.input-group-btn').find('.nav-search__select');

  select.text(data.$this.text());
  select.data('method', data.$this.data('method') || null);
  select.data('params', data.$this.data('params') || null);
});


N.wire.on(module.apiPath + ':submit', function submit_search(data) {
  // remove click and keydown listeners
  hide_search_bar();

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
