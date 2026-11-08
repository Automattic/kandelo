"use strict";
// Real OS pipe/PTY reads and native target onStreamRead. Candidate factory is
// generated normally; Node stream/TTY/pipe/async owners are explicit component
// dependencies, not guest provider/GC/fatal conformance.
const fs=require('node:fs'),path=require('node:path'),tty=require('node:tty'),net=require('node:net'),assert=require('node:assert/strict');
const {internalBinding}=require('internal/test/binding'),{FastBuffer}=require('internal/buffer');
const [subject,mode,poisonMode]=process.argv.slice(2);assert.equal(process.version,'v26.13.0');
const root=process.env.FD_PUBLISH_REPO,ev=process.env.FD_PUBLISH_EVIDENCE;
const U8=Uint8Array,typed=Object.getPrototypeOf(U8.prototype),lengthGet=Object.getOwnPropertyDescriptor(typed,'length').get,offsetGet=Object.getOwnPropertyDescriptor(typed,'byteOffset').get,bufferGet=Object.getOwnPropertyDescriptor(typed,'buffer').get;
const apply=Reflect.apply,BufferFrom=Buffer.from,get=(fn,x)=>apply(fn,x,[]);const rawSpans=[],chunks=[];let hookCalls=0;
const source=mode==='generic-promise'?new net.Socket({fd:0,readable:true,writable:false}):new tty.ReadStream(0);
assert.equal(tty.isatty(0),mode!=='generic-promise');
function remember(bytes){rawSpans.push({buffer:get(bufferGet,bytes),offset:get(offsetGet,bytes),length:get(lengthGet,bytes)});return bytes;}
let input,restore=()=>{},closed=false;
function poison(){const key=poisonMode==='public-from'?'from':poisonMode==='valueOf'?'valueOf':Symbol.iterator,owner=poisonMode==='public-from'?Buffer:U8.prototype,desc=Object.getOwnPropertyDescriptor(owner,key),marker=Error('poisoned '+poisonMode);Object.defineProperty(owner,key,{configurable:true,get(){hookCalls++;throw marker;}});restore=()=>{if(desc)Object.defineProperty(owner,key,desc);else delete owner[key];};}
if(subject==='native'){
 const handle=source._handle,original=handle.onread,binding=internalBinding('stream_wrap');
 handle.onread=function(buffer){const count=binding.streamBaseState[binding.kReadBytesOrError],offset=binding.streamBaseState[binding.kArrayBufferOffset];if(count>0)rawSpans.push({buffer,offset,length:count});return apply(original,this,[buffer]);};input=source;
}else{
 const bundle=fs.readFileSync(subject==='before'?path.join(ev,'bundle-before.js'):path.join(root,'third_party/node-core/node-core.js'),'utf8');const factory=Function(bundle+';return _createNodeFdStreamPlatform;')();
 const pending=new Map();
 function readFrom(limit){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
  function cleanup(){source.off('readable',ready);source.off('end',ready);source.off('error',failed);pending.delete(promise);}
  function failed(error){cleanup();reject(error);}
  function ready(){const length=source.readableLength;if(length){const bytes=source.read(Math.min(length,limit,Number(process.env.FD_PUBLISH_READ_WINDOW)||limit));if(bytes!==null){cleanup();resolve(remember(bytes));return;}}source.read(0);if(source.readableEnded){cleanup();resolve(new U8(0));}}
  pending.set(promise,{cancel(){cleanup();source.pause();reject(Object.assign(Error('cancelled'),{code:'ECANCELED'}));}});source.on('readable',ready);source.on('end',ready);source.on('error',failed);ready();return promise;
 }
 let bound,activeCallback;
 const terminal={bind(stream){bound=stream;},ref(value){value?source.ref():source.unref();},close(){source.destroy();},read:readFrom,control(promise,value){const record=pending.get(promise);if(!record)return false;if(value===null)record.cancel();else value?source.ref():source.unref();return true;},error(status){return Object.assign(Error('read error'),{errno:status});},
  start(limit,callback){activeCallback=bytes=>{source.pause();activeCallback=null;callback(0,remember(bytes));};source.once('data',activeCallback);source.resume();},
  stop(){if(!activeCallback)return false;source.off('data',activeCallback);activeCallback=null;source.pause();return true;}};
 if(mode!=='terminal-callback')delete terminal.start;
 const owner=factory({stream:require('node:stream'),Buffer,FastBuffer,process,
  ...(mode==='generic-promise'?{}:{openTerminalInput(fd){assert.equal(tty.isatty(fd),true);return terminal;}}),
  native:{__kandeloFdRead(_fd,limit){return readFrom(limit);},__kandeloFdReadControl(promise,value){return terminal.control(promise,value);}}});input=owner.readable(0);
}
function finish(error){if(closed)return;closed=true;restore();let bytes=Buffer.alloc(0),alias=true;for(const chunk of chunks){assert(Buffer.isBuffer(chunk));bytes=Buffer.concat([bytes,chunk]);const backing=get(bufferGet,chunk),offset=get(offsetGet,chunk),length=get(lengthGet,chunk);if(!rawSpans.some(span=>span.buffer===backing&&span.offset===offset&&span.length===length))alias=false;}
 const result={subject,mode,poisonMode,hookCalls,hex:bytes.toString('hex'),retainsNativeSpan:alias&&chunks.length>0,nonzeroNativeOffset:rawSpans.some(span=>span.offset>0),nativeSpanWindows:rawSpans.map(span=>[span.offset,span.length]),error:error?{name:error.name,message:error.message}:null};
 input.destroy();source.destroy();console.log(JSON.stringify(result));}
// Drain initial diagnostic warning tasks before installing mutation hooks.
setImmediate(()=>{poison();input.on('data',bytes=>{chunks.push(bytes);if(chunks.reduce((n,b)=>n+get(lengthGet,b),0)>=4)finish();});input.on('error',finish);input.resume();});
setTimeout(()=>finish(Error('read control timeout')),4000).unref();
