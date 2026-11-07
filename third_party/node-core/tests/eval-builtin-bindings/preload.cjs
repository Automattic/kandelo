'use strict';
// Unchanged native REPL consumer with only this genuine candidate shared
// builtin-binding helper selected. Native REPL/VM/stream/capture remain explicit.
const path=require('node:path'),vm=require('node:vm');const repo=process.env.KANDELO_BUILTIN_BINDINGS_REPO;
const api=require(path.join(repo,'host/test/fixtures/node-module-records.cjs')).create({skipESMResolver:true});
const records=vm.runInContext('_nodeModuleRecords',api.context);
require('internal/modules/helpers').addBuiltinLibsToObject=records.addBuiltinLibsToObject;
