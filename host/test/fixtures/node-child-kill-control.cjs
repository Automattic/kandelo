'use strict';
// Exact native Node ChildProcess.prototype.kill versus actual bootstrap kill
// frontend. Injected status/errors are explicit bridge dependencies; separate
// real child controls below perform host kill(2), never guest JSAPI execution.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const cp=require('node:child_process'),events=require('node:events'),util=require('node:util'),os=require('node:os');
const uv=process.binding('uv');
const root=path.resolve(__dirname,'../../..');
const input=process.argv.slice(2).find(arg=>!arg.startsWith('--'));
const source=fs.readFileSync(input||path.join(root,'packages/registry/node-compat/bootstrap.js'),'utf8');
const bundle=fs.readFileSync(path.join(root,'third_party/node-core/node-core.js'),'utf8');
const factory=Function(bundle+';return _createNodeValuesPlatform;')();
const values=factory({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const start=source.indexOf('        child.kill = function (sig) {'),end=source.indexOf('        child.ref = function()',start);
assert(start>=0&&end>start);const body=source.slice(start,end);
const failures=[],rows=[];
function shape(error){if(!error)return null;return {name:error.name,message:error.message,code:error.code,errno:error.errno,syscall:error.syscall,enumerable:Object.keys(error).sort()};}
function judge(label,input,status,options={}){
 const one=native=>{
  const child=new events.EventEmitter();child.killed=!!options.killed;
  const calls=[],emitted=[],trace=['before'];const token=Error('exact native bridge exception');
  if(!options.noListener)child.on('error',error=>{trace.push('error');emitted.push(shape(error));if(options.listenerThrow)throw token;});
  const handle={kill(signum){calls.push(signum);if(options.bridgeThrow)throw token;return status;}};
  if(native){child._handle=options.exited?null:handle;child.kill=cp.ChildProcess.prototype.kill;}
  else {
   const boundary={__kandeloKill(pid,signal){assert.equal(pid,123);calls.push(signal);if(options.bridgeThrow)throw token;if(status)throw Object.assign(Error('kill 123: actual native strerror'),{errno:-status},options.omitCode?{}:{code:util.getSystemErrorName(status)});return 0;}};
   Function('child','_nodeValues','_nn','pid','exited',body)(child,values,boundary,123,!!options.exited);
  }
  let result,error,sameToken=false;try{result=child.kill(input);trace.push('after');}catch(e){error=shape(e);sameToken=e===token;trace.push('throw');}
  return {result,error,sameToken,calls,emitted,trace,killed:child.killed};
 };
 const expected=one(true),actual=one(false);
 try{assert.deepEqual(actual,expected,label);rows.push({label,pass:true});}
 catch(error){failures.push({label,expected,actual});rows.push({label,pass:false});}
}
judge('numeric zero probes and marks killed',0,0);
judge('negative zero preserved',-0,0);
judge('default SIGTERM',undefined,0);
judge('lowercase SIGTERM','sigterm',0);
judge('actual named numeric signal',os.constants.signals.SIGTERM,0);
for(const [label,value] of [['null',null],['false',false],['NaN',NaN],['infinity',Infinity],['fraction',1.1],['unknown number',1000000],['negative',-1],['string zero','0'],['unknown string','SIG_NOT_REAL'],['object',{}],['symbol',Symbol('signal')],['bigint',0n],['boxed name',new String('SIGTERM')]])judge('reject '+label,value,0);
for(const value of [0,undefined,'sigterm'])judge('reaped validates then returns false '+String(value),value,0,{exited:true,killed:true});
judge('reaped still rejects unknown','SIG_NOT_REAL',0,{exited:true});
for(const [name,status] of [['ESRCH',uv.UV_ESRCH],['EINVAL',uv.UV_EINVAL],['ENOSYS',uv.UV_ENOSYS],['EPERM',uv.UV_EPERM]]){
 judge(name+' exact public error/return/event',0,status);
 judge(name+' preserves previously true killed',undefined,status,{killed:true});
}
judge('ENOSYS without native code decoration',0,uv.UV_ENOSYS,{omitCode:true});
judge('ENOSYS without code preserves killed',undefined,uv.UV_ENOSYS,{omitCode:true,killed:true});
judge('EPERM without error listener throws exact Node error',0,uv.UV_EPERM,{noListener:true});
judge('error listener exception propagates unchanged',0,uv.UV_EPERM,{listenerThrow:true});
judge('unexpected native exception propagates unchanged',0,0,{bridgeThrow:true});
console.log(JSON.stringify({scope:'Actual frontend conversion/error lifecycle differential with explicit bridge dependencies; no guest claim',node:process.version,rows,failures},null,2));
if(failures.length){process.exitCode=1;}
else if(process.argv.includes('--live')){
 const owner=require(path.join(root,'host/test/fixtures/node-child-owner.cjs'));
 async function run(label,api){
  const child=api.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  try{
   await events.once(child,'spawn');assert.equal(child.killed,false);
   assert.equal(child.kill(0),true);assert.equal(child.killed,true);assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
   process.kill(child.pid,0);await new Promise(resolve=>setImmediate(resolve));process.kill(child.pid,0);
   assert.throws(()=>child.kill('SIG_NOT_REAL'),{code:'ERR_UNKNOWN_SIGNAL'});process.kill(child.pid,0);
   const closed=events.once(child,'close');assert.equal(child.kill('sigterm'),true);
   const [code,signal]=await closed;assert.equal(code,null);assert.equal(signal,'SIGTERM');assert.equal(child.exitCode,null);assert.equal(child.signalCode,'SIGTERM');
   assert.equal(child.kill(0),false);assert.equal(child.killed,true);assert.throws(()=>child.kill('SIG_NOT_REAL'),{code:'ERR_UNKNOWN_SIGNAL'});
   return {label,zeroKeptRealChildAlive:true,lowercaseTerminatedRealChild:true,reapedKillFalse:true,killedPreserved:true,code,signal};
  }finally{
   if(child.exitCode===null&&child.signalCode===null){const closed=events.once(child,'close');child.kill('SIGKILL');await closed;}
  }
 }
 (async()=>{const actual=owner.create();try{const expected=await run('native',cp),candidate=await run('actual bootstrap over real native boundary',actual);assert.deepEqual({...candidate,label:null},{...expected,label:null});console.log(JSON.stringify({realOwnChildDifferential:[expected,candidate],guestRuntime:false}));}finally{await actual.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
}
