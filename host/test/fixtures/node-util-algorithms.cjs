'use strict';
const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const globals=['internalBinding','primordials'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
const {internalBinding}=require('internal/test/binding');
for(const [key,d] of globals){if(d)Object.defineProperty(globalThis,key,d);else delete globalThis[key];}
const source=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,install:_installNodeUtilAlgorithms,style:_installNodeUtilStyle};')();
exports.create=function create(){
 const values=factories.values({process,Buffer,util,inspection:util,uv:{binding:internalBinding('uv')},os:require('node:os'),signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
 const api={inspect:util.inspect};
 const lazyPath=process.env.NODE_UTIL_LAZY_REFERENCE_BINDING;
 if(!lazyPath)throw Error('NODE_UTIL_LAZY_REFERENCE_BINDING must identify the actual pinned V8 lazy DATA reference addon');
 const {defineNativeLazyDataProperty}=require(lazyPath);
 factories.install({defineNativeLazyDataProperty,util:api,values,process,timers:require('node:timers'),addAbortListener:require('node:events').addAbortListener,
  markPromiseAsHandled:value=>util.markPromiseAsHandled(value),getLibuvNow:()=>internalBinding('timers').getLibuvNow(),
  getOptionValue:require('internal/options').getOptionValue});
 const bootstrap=fs.readFileSync(path.resolve(__dirname,'../../../packages/registry/node-compat/bootstrap.js'),'utf8');
 const start=bootstrap.indexOf('_installNodeUtilStyle({ util, process, Buffer, values: _nodeValues,');
 const end=bootstrap.indexOf('// Assertion diagnostics',start);
 if(start<0||end<start)throw Error('Missing actual util styling production install');
 Function('_installNodeUtilStyle','util','process','Buffer','_nodeValues','_nodeStreamPlatform',bootstrap.slice(start,end))(
  factories.style,api,process,Buffer,values,{require:require});
 return api;
};
