'use strict';
const path=require('node:path');
const root=path.resolve(__dirname,'../../../..');
const descriptors=Object.fromEntries(['internalBinding','primordials'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
require('internal/test/binding');
for(const [key,descriptor]of Object.entries(descriptors)) {
  if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
}
process.nextTick(()=>{
 const api=require(path.join(root,'host/test/fixtures/node-module-records.cjs')).create({skipESMResolver:true,sameRealmCJS:true});
 api.proc.emitWarning=(...args)=>process.emitWarning(...args);
 const filename=path.resolve(process.argv[2]);
 api.Module.createRequire(filename)(filename);
});
