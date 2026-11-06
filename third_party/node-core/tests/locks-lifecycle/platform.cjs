'use strict';
// Component only: actual portable native execution owner/manager through N-API.
// Host Promise/error/WebIDL dependencies are explicit; no SM/guest acceptance.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),util=require('node:util');
const worker=require('node:worker_threads');
module.exports=function create(bundle,managerPath,executionPath){
 const core=fs.readFileSync(bundle,'utf8');
 const factories=Function(core+';return {values:_createNodeValuesPlatform,async:_createNodeAsyncPlatform,locks:_createNodeLocksPlatform}')();
 const values=factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
 const execution=require(path.resolve(executionPath));execution.clearAsyncExecution();
 const addon=require(path.resolve(managerPath));const destroys=[];let lifecycle,zeroEntries=0;
 const native={...execution,
  pushAsyncExecution(...args){if(args[0]===0&&args[1]===0)zeroEntries++;return execution.pushAsyncExecution(...args)},
  setAsyncLifecycle(fn){lifecycle=fn},setAsyncDestroyTracking(){},isPromise:util.types.isPromise,
  getAsyncResourceInfo(){throw Error('No replacement native resource metadata in this control')},
  enqueueAsyncDestroyId(id,promise){destroys.push([id,promise])},drainNativeAsyncDestroyIds(){return destroys.splice(0)},
  asyncHookFatal(error){throw error},
 };
 const async=factories.async({native,values,process});
 const globals=['internalBinding','primordials'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
 const {internalBinding}=require('internal/test/binding');
 for(const [key,descriptor]of globals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
 const locks=factories.locks({native:{locks:addon.locks,markPromiseAsHandled:internalBinding('util').markPromiseAsHandled},
  process,worker:{threadId:worker.threadId},values,types:util.types,diagnostics:require('node:diagnostics_channel'),
  runInternalImmediate:async.runInternalImmediate,eventRequire:require});
 return {zeroEntries:()=>zeroEntries,api:locks.require('internal/locks').locks,locks,async,execution,addon,lifecycle};
};
