'use strict';
// Host component dependency boundary: actual portable poll owner and POSIX
// worker stats, pinned public slices, actual Node Events/path/async primitives.
// This never substitutes Node fs.watchFile as the candidate's backend.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const {fileURLToPath}=require('node:url');
const {createHook}=require('node:async_hooks');
const internals=require('internal/async_hooks');
exports.create=function create(){
 const addon=require(process.env.KANDELO_STAT_WATCHER_ADDON);
 const ids=new WeakMap();const hook=createHook({init(id,type,trigger,resource){if(type==='STATWATCHER-component')ids.set(resource,id);}}).enable();
 addon.statWatcher('configure',owner=>{const id=ids.get(owner);if(typeof id!=='number')throw Error('Missing real native component async ID');return id;});
 const core=fs.readFileSync(path.resolve(__dirname,'../../../third_party/node-core/node-core.js'),'utf8');
 const adapter=fs.readFileSync(process.env.KANDELO_STAT_WATCHER_ADAPTER,'utf8');
 const factories=Function(core+'\n'+adapter+';return {values:_createNodeValuesPlatform,stats:_createNodeFsStats,watch:_createNodeStatWatcherPlatform};')();
 const values=factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
 const truncation={vfsState:{handlers:null}};
 const utils=factories.stats({fs,process,Buffer,types:util.types,values,truncation,native:{},permissionEnabled:()=>false,toPathIfFileURL:value=>value instanceof URL?fileURLToPath(value):value});
 const api=factories.watch({values,utils,async:{defaultTriggerAsyncIdScope:internals.defaultTriggerAsyncIdScope,symbols:internals.symbols},events:require('node:events'),process,path,truncation,native:addon});
 return {api,close:()=>hook.disable()};
};
