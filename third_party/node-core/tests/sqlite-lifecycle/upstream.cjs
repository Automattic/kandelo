'use strict';
// Execute the whole byte-identical upstream file, selecting only close/dispose
// suites through native node:test filtering. Native common/test/VM are explicit
// dependencies; only node:sqlite is supplied by the actual frontend factory.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),M=require('node:module');
const file=process.env.KANDELO_SQLITE_UPSTREAM_FILE,tool=process.env.KANDELO_SQLITE_PARAMETER_TOOL;
if(!file||!tool)throw Error('Explicit upstream file and metadata tool required');
const nativeRequire=M.createRequire(file),api=process.env.KANDELO_SQLITE_CONTROL_MODE==='native'?require('node:sqlite'):require('./frontend.cjs')(tool);
const requireBoundary=name=>name==='node:sqlite'?api:nativeRequire(name);
const record={exports:{}};
const run=vm.compileFunction(fs.readFileSync(file,'utf8'),['exports','require','module','__filename','__dirname'],{filename:file});
Reflect.apply(run,record.exports,[record.exports,requireBoundary,record,file,path.dirname(file)]);
