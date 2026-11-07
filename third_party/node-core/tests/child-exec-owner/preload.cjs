'use strict';
const native=require('node:child_process');const api=require('./load.cjs')('after',process.env.KANDELO_CHILD_EXEC_REPO);
native.exec=api.exec;native.execFile=api.execFile;
