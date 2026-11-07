'use strict';
// Exact bootstrap owner over genuine native POSIX fds/actions and explicit
// native Node stream/error/loop dependencies. This is not the guest JSAPI.
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),events=require('node:events'),stream=require('node:stream');
const component=require(process.env.SPAWN_COMPONENT);
const root=path.resolve(__dirname,'../../../..');
const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factories=Function(bundle+';return{values:_createNodeValuesPlatform,primordials:_createNodePrimordials};')();
exports.component=component;
exports.create=function(settings={}){
 const source=fs.readFileSync(settings.source||path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
 function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);if(a<0||b<a)throw Error('Missing exact source section');return source.slice(a,b)}
 const ChildProcess=Function('events',section('child_process.ChildProcess = (function () {','// ============================================================\n// crypto module').replace('child_process.ChildProcess =','const ChildProcess =')+';return ChildProcess;')(events);
 const values=factories.values({process,Buffer,util,inspection:util,os:require('node:os'),signals:require('node:os').constants.signals,getDOMException:()=>DOMException});
 const created=[],closed=[],livePids=new Set();let pipeCalls=0,spawnCalls=0;
 const native={isNativeError:util.types.isNativeError,
  __kandeloPipe(reads,minimum){
   pipeCalls++;
   const fillers=[];
   if(settings.pressureAt===pipeCalls){try{while(true)fillers.push(fs.openSync('/dev/null','r'))}catch(error){if(error.code!=='EMFILE')throw error}}
   try{
    const pair=component.pipe(reads,minimum);
    const r=pair[0],w=pair[1];created.push({r,w,readFlags:component.flags(r),writeFlags:component.flags(w),parentReads:reads});
    return pair;
   }finally{for(let i=0;i<fillers.length;i++)fs.closeSync(fillers[i])}
  },
  __kandeloFdClose(fd){closed.push(fd);component.close(fd)},
  __kandeloFdRead(fd,size){
   // Actual native nonblocking read readiness; not the guest watch owner.
   return new Promise((resolve,reject)=>{const deadline=Date.now()+3000;function attempt(){try{const buffer=Buffer.alloc(size),length=fs.readSync(fd,buffer,0,size,null);resolve(Uint8Array.from(buffer.subarray(0,length)).buffer)}catch(error){if(error.code==='EAGAIN'&&Date.now()<deadline)setImmediate(attempt);else reject(error)}}attempt()})
  },
  __kandeloFdWrite(fd,bytes){return new Promise((resolve,reject)=>{try{let offset=0;while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset);resolve()}catch(error){reject(error)}})},
  __kandeloFdReadControl(){throw Error('Read cancellation is outside this native component boundary')},
  __kandeloWaitPid(pid){
   // Notification is a genuine future native-loop completion, as the guest
   // watch is polled after the public spawn call. An already-resolved Promise
   // would introduce a fixture-only Promise-before-nextTick race.
   return new Promise((resolve,reject)=>setImmediate(()=>{try{const result=component.wait(pid);livePids.delete(pid);if(result.signal!==null)result.signal=Object.entries(require('node:os').constants.signals).find(([,number])=>number===result.signal)?.[0]||result.signal;resolve(result)}catch(error){reject(error)}}));
  },
  __kandeloKill(pid,signal){process.kill(pid,signal)},
  socketRef(){throw Error('Wait-ref owner is outside this native component boundary')},
 };
 const scope={ChildProcess};
 function spawn(file,argv,env,actions,cwd,attrs){
  spawnCalls++;
  if(settings.stopLaunch)throw settings.stopLaunch;
  // Arguments/actions are real; this launches/reaps actual native fixtures.
  const pid=component.spawn(file,argv,env,actions);livePids.add(pid);return pid;
 }
 const body=section('    function _spawn(command, args, options) {','    function exec(command, options, cb) {');
 const api=Function('events','stream','Buffer','process','_nn','_spawnWithPath','_nodeValues','child_process','_childPrimordials','_nodeFsStats',body+';return{spawn:_spawn,runWithCallback:_runWithCallback};')(events,stream,Buffer,process,native,spawn,values,scope,factories.primordials(),require('internal/fs/utils'));
 return{...api,created,closed,ChildProcess,get pipeCalls(){return pipeCalls},get spawnCalls(){return spawnCalls},
  cleanup(){for(const pair of created)for(const fd of [pair.r,pair.w]){try{component.flags(fd);component.close(fd)}catch(error){if(error.errno!==require('node:os').constants.errno.EBADF)throw error}}for(const pid of livePids){try{process.kill(pid,'SIGKILL')}catch{}try{component.wait(pid)}catch{}livePids.delete(pid)}}};
};
