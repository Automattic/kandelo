'use strict';
const Module = require('node:module');
const subject = require('./node-url-path-platform.cjs').create();
const api = { URL: subject.URL, URLSearchParams: subject.web.URLSearchParams };
for (const name of ['fileURLToPath', 'fileURLToPathBuffer', 'pathToFileURL', 'urlToHttpOptions']) api[name] = subject[name];
const load = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'url' || request === 'node:url') return api;
  return Reflect.apply(load, this, [request, parent, isMain]);
};
// Public/global constructors share the candidate parser, as in production.
// Native common/node:test/FS/Buffer remain explicit control dependencies.
globalThis.URL = subject.URL;
globalThis.URLSearchParams = subject.web.URLSearchParams;
