'use strict';

exports.root = __dirname;
exports.name = 'nodeca.search';

exports.init = function (N) { require('./lib/autoload.js')(N); };

exports.server = require('./lib/server');
exports.escape = require('./lib/escape');
