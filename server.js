#!/usr/bin/env node

'use strict';

const path   = require('path');
const url    = require('url');
const Server = require('./').server;


let listen = url.format({
  protocol: 'http',
  hostname: process.env.HOST || 'localhost',
  port:     process.env.PORT || 9304,
  path:     '/'
});


/* eslint-disable no-console */
let server = new Server(process.argv[2] || path.resolve(__dirname, 'sphinx_data'));

server
  .start(listen)
  .then(() => console.log('Server is started on ' + listen))
  .catch(err => {
    console.log(err.stack);
    process.exit(1);
  });


process.on('SIGINT', function () {
  server.stop().catch(() => {}).then(() => process.exit());
});
