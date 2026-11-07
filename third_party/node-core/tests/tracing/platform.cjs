'use strict';
// Actual candidate source and process owner. Native Node supplies the explicit
// fixture engine/inspection/streams/loader/clock/async/process dependencies.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const source=fs.readFileSync(path.resolve(__dirname,'../../node-core.js'),'utf8');
const factory=Function(source+';return {values:_createNodeValuesPlatform,diagnostics:_createNodeDiagnosticsPlatform,console:_createNodeConsolePlatform,tracing:_createNodeTracingOwner};')();
const inspection=require('internal/util/inspect');
const before=['internalBinding','primordials'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
let internalBinding;
try { ({internalBinding}=require('internal/test/binding')); }
finally { for(const [name,descriptor] of before) {if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];} }
const values=factory.values({process,Buffer,util,inspection,os:require('node:os'),signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
const native=require(process.env.TRACING_COMPONENT);
const tracing=factory.tracing({native,values,uv:{getSystemErrorName:util.getSystemErrorName,getSystemErrorMessage:util.getSystemErrorMessage}});
const diagnostics=factory.diagnostics({process,values,types:util.types});
const owner=factory.console({process,values,inspection,Buffer,types:util.types,diagnostics,
  readline:{callbacks:require('node:readline')},previewEntries:internalBinding('util').previewEntries,
  monotonicNanoseconds:process.hrtime.bigint.bind(process.hrtime),tracing,
  ownsProcessState:require('node:worker_threads').isMainThread});
exports.owner=owner;exports.native=native;exports.tracing=tracing;
