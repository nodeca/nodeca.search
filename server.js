#!/usr/bin/env node

'use strict';

const fs       = require('fs');
const path     = require('path');
const argparse = require('argparse');
const log4js   = require('log4js');
const yaml     = require('js-yaml');
const cluster  = require('cluster');
const Server   = require('./').server;

let parser = new argparse.ArgumentParser({ add_help: true });

parser.add_argument('-c', '--config', { help: 'path to config file' });
parser.add_argument('-p', '--path',   { help: 'path to sphinx_data folder' });
parser.add_argument('-l', '--listen', { help: 'host:port to listen on' });

let args = parser.parse_args();
let config = {};

if (args.config) {
  config = yaml.load(fs.readFileSync(args.config, 'utf8'))?.search_service;
}

let appenders = {
  console: { type: 'console' }
};

let categories = {
  default:        { appenders: [ 'console' ], level: 'info' },
  'search.query': { appenders: [ 'console' ], level: 'off' }
};

if (config?.log?.system) {
  appenders['file.system'] = {
    type:       'file',
    filename:   config.log.system.filename,
    maxLogSize: config.log.system.maxLogSize,
    backups:    config.log.system.backups
  };
  categories['default'].appenders.push('file.system');
}

if (config?.log?.search) {
  appenders['file.search'] = {
    type:       'file',
    filename:   config.log.search.filename,
    maxLogSize: config.log.search.maxLogSize,
    backups:    config.log.search.backups
  };
  categories['search.query'] = { appenders: [ 'file.search' ], level: 'info' };
}

log4js.configure({
  appenders,
  categories,
  disableClustering: true
});


let listen = args.listen || config?.listen || 'localhost:9304';
if (!listen.includes(':')) listen = 'localhost:' + listen;

let server = new Server(args.path || config?.path || path.resolve(__dirname, 'sphinx_data'));

server
  .start(`http://${listen}/`)
  .then(() => {
    if (cluster.isWorker) process.send('ready');
  })
  .catch(() => {
    process.exit(1);
  });


process.on('SIGINT', function () {
  log4js.getLogger('search.system').info('Received SIGINT');
  server.stop().catch(() => {}).then(() => process.exit());
});

process.on('uncaughtException', function (err) {
  let message = 'Uncaught exception: ' + (err.stack || err);
  log4js.getLogger('search.system').fatal(message);
});

process.on('unhandledRejection', function (err) {
  let message = 'Unhandled rejection: ' + (err.stack || err);
  log4js.getLogger('search.system').fatal(message);
});
