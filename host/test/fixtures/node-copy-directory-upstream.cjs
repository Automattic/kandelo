'use strict';
// Explicit selected-API preload; all non-cp dependencies remain native Node.
const fs=require('node:fs');
const candidate=require('./node-copy-directory-platform.cjs').create();
Object.assign(fs,candidate.api);
Object.assign(fs.promises,candidate.promises);
require('node:module').syncBuiltinESMExports();
