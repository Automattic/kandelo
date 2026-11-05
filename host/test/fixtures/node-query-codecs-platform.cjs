'use strict';
// Actual candidate factories. Native internal origin/Buffer are explicit
// upstream control boundaries; focused controls can select candidate Buffer.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util');
const root=path.resolve(__dirname,'../../..');
const source=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factories=Function(source+';return {values:_createNodeValuesPlatform,query:_createNodeQueryCodecsPlatform};')();
let origin;
function nativeOrigin() {
 if(origin)return origin;
 const descriptors=['internalBinding','primordials'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]);
 try {origin=require('internal/test/binding').internalBinding('util').isInsideNodeModules;}
 finally {for(const [name,descriptor] of descriptors){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}}
 return origin;
}
exports.create=function create(options={}){
 const Buffer=options.Buffer??globalThis.Buffer,processControl=options.process??process;
 const values=factories.values({process:processControl,Buffer,util,inspection:util,os:require('node:os'),
  signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
 return factories.query({process:processControl,Buffer,values,isInsideNodeModules:options.isInsideNodeModules??nativeOrigin()});
};
exports.originMethod=function originMethod(captureSavedStack,bootstrapStackSource){
 const adapter=fs.readFileSync(path.join(root,'packages/registry/spidermonkey/node-compat/adapter.js'),'utf8');
 const start=adapter.indexOf('        isInsideNodeModules(frameLimit = 10) {');
 const end=adapter.indexOf('        captureCallSites(frameCount)',start);
 if(start<0||end<start)throw Error('Missing actual saved-frame origin source');
 const call=Function('captureSavedStack','bootstrapStackSource','stackSourceStartsWith','stackSourceIncludes',
  'return ({'+adapter.slice(start,end)+'}).isInsideNodeModules;');
 return call(captureSavedStack,bootstrapStackSource,Function.call.bind(String.prototype.startsWith),Function.call.bind(String.prototype.includes));
};

exports.nativeOrigin=nativeOrigin;
