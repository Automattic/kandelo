'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
process.on('uncaughtException',error=>{fs.writeSync(Number(process.env.REPORT_FD),JSON.stringify({harnessError:error.stack})+'\n');process.exitCode=1;});
const util=require('node:util'),os=require('node:os'),events=require('node:events');
const streams=require('node:stream'),tty=require('node:tty'),readline=require('node:readline');
const asyncHooks=require('node:async_hooks');
assert.equal(process.version,'v26.13.0');
const directory=fs.realpathSync(process.env.STDIO_RESIZE_DIR),mode=process.argv[2];
const helper=require(path.resolve(directory,'../tty-output-publication-owner-agent/component/window.node'));
const restore=Number(process.env.RESTORE_FD),reportFd=Number(process.env.REPORT_FD);
const rows=[];
const bounded=(promise)=>Promise.race([promise,new Promise((_,reject)=>{
 const timer=setTimeout(()=>reject(Error('No real resize signal completed within bounded control')),500);
 promise.finally(()=>clearTimeout(timer)).catch(()=>{});
})]);
async function group(name,body){try{rows.push({name,pass:true,value:await body()});}catch(error){rows.push({name,pass:false,error:error.stack});}}
const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function resize(output,errorOutput,columns,lines,fd=1){
 const pending=Promise.all([events.once(output,'resize'),events.once(errorOutput,'resize')]);
 assert.equal(helper.resize(fd,columns,lines).error,0);
 process.kill(process.pid,'SIGWINCH');
 await bounded(pending);return[output.columns,output.rows,errorOutput.columns,errorOutput.rows];
}
const source=mode==='before'?fs.readFileSync(path.join(directory,'before/packages/registry/node-compat/bootstrap.js'),'utf8'):
 fs.readFileSync(path.join(directory,'repo/packages/registry/node-compat/bootstrap.js'),'utf8');
const core=fs.readFileSync(path.join(directory,mode==='before'?'baseline-core.js':'after-core.js'),'utf8');
const factories=Function(core+';return{values:_createNodeValuesPlatform,terminal:_createNodeTerminalPlatform,fd:_createNodeFdStreamPlatform,signals:_createNodeProcessSignals,stdio:typeof _createNodeStdioOutputPlatform==="function"?_createNodeStdioOutputPlatform:undefined};')();
const values=factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const NativeSignal=require('internal/test/binding').internalBinding('signal_wrap').Signal;
const signalMethods={};for(const key of ['start','stop','close','ref','unref','hasRef','getAsyncId'])signalMethods[key]=NativeSignal.prototype[key];
function platform(main=true){
 const proc=new events.EventEmitter(),owners=[],signalHandles=new Set();
 const counts={created:0,started:0,closed:0,closedCompleted:0,outputClosed:0};
 const native={workerEnvironment:main?null:{},signalOperation(operation,owner,...args){
  if(operation==='create'){const actual=new NativeSignal();Object.setPrototypeOf(actual,owner);counts.created++;signalHandles.add(actual);return actual;}
  if(operation==='start')counts.started++;
  if(operation==='close'){
   counts.closed++;const callback=args[0];return Reflect.apply(signalMethods.close,owner,[()=>{counts.closedCompleted++;signalHandles.delete(owner);if(callback)callback();}]);
  }
  return Reflect.apply(signalMethods[operation],owner,args);
 },operatingSystem(operation,...args){
  if(operation==='tty-output-open'){const result=helper.openOutput(...args);if(!result.error)owners.push(result.value);return result;}
  if(operation==='tty-output-close'){counts.outputClosed++;return helper.closeOutput(...args);}
  if(operation==='tty-output-write')return helper.writeOutput(...args);
  if(operation==='tty-output-size')return helper.outputSize(...args);
  if(operation==='tty-size')return helper.windowSize(...args);
  throw Error('Missing actual component operation '+operation);
 },__kandeloFdWrite(fd,bytes){fs.writeSync(fd,bytes);return Promise.resolve(bytes.length);}};
 const signals=factories.signals({process:proc,native,values,signals:os.constants.signals});
 const terminal=factories.terminal({values,native,uv:{getSystemErrorName:util.getSystemErrorName,getSystemErrorMessage:util.getSystemErrorMessage},isTTY:tty.isatty,getReadline:()=>readline});
 const fd=factories.fd({stream:streams,Buffer,process:proc,native,openTerminalOutput:terminal.openOutput});
 let get;
 if(mode==='before'){
  const a=source.indexOf('function _createWriteStream(fd) {'),b=source.indexOf('function _createReadStream(fd) {',a);
  // This is the actual unchanged qjs:os signal method being replaced, not a
  // substitute success path for the candidate.
  get=Function('_nodeFdStreamPlatform','_nodeTerminalPlatform','os','let _stdout,_stderr;'+source.slice(a,b)+';return _createWriteStream;')(fd,terminal,{signal(){}});
 }else{
  const marker='_nodeStdioOutputPlatform = _createNodeStdioOutputPlatform({';const a=source.indexOf(marker),b=source.indexOf('// Public styling consumes',a);assert(a>=0&&b>a);
  const c=source.indexOf('function _createWriteStream(fd) {'),d=source.indexOf('function _createReadStream(fd) {',c);
  get=Function('_createNodeStdioOutputPlatform','process','_nodeFdStreamPlatform','_nodeTerminalPlatform','_nodeProcessSignals','_nodeNative',
   'let _nodeStdioOutputPlatform;'+source.slice(a,b)+source.slice(c,d)+';return _createWriteStream;')(factories.stdio,proc,fd,terminal,signals,native);
 }
 Object.defineProperties(proc,{stdout:{get(){return get(1)}},stderr:{get(){return get(2)}}});
 return{proc,owners,counts,async close(){proc.removeAllListeners('SIGWINCH');await pause();for(const owner of owners)helper.closeOutput(owner);}};
}
(async()=>{
 if(mode==='native'){
  await group('real SIGWINCH refreshes native stdout and stderr',async()=>{
   const dimensions=await resize(process.stdout,process.stderr,81,25);assert.deepEqual(dimensions,[81,25,81,25]);return dimensions;
  });
 }else{
  await group('real SIGWINCH refreshes two captured stdio owners through shared signal wrap',async()=>{
   const p=platform();try{const out=p.proc.stdout,err=p.proc.stderr;assert.equal(p.counts.started,1);const dimensions=await resize(out,err,81,25);assert.deepEqual(dimensions,[81,25,81,25]);assert.equal(p.proc.stdout,out);return{dimensions,signalOwners:p.counts.created,listeners:p.proc.rawListeners('SIGWINCH').map(fn=>fn.name)};}finally{await p.close();}
  });
  await group('actual start/init listener reentry observes same published stream',async()=>{
   const p=platform();let seen,fromInit;const hook=asyncHooks.createHook({init(_id,type){if(type==='SIGNALWRAP')fromInit=p.proc.stdout}}).enable();try{p.proc.on('newListener',name=>{if(name==='SIGWINCH')seen=p.proc.stdout});const out=p.proc.stdout;assert.equal(seen,out);assert.equal(fromInit,out);assert.equal(p.owners.length,1);return{same:seen===out,nativeInitSame:fromInit===out};}finally{hook.disable();await p.close();}
  });
  await group('throwing registration rolls back real signal and captured output then permits retry',async()=>{
   const p=platform(),original={registration:true};const fail=name=>{if(name==='SIGWINCH')throw original};try{
    p.proc.on('newListener',fail);let thrown;try{p.proc.stdout}catch(error){thrown=error}assert.equal(thrown,original);assert.equal(helper.descriptor(p.owners[0]),-1);assert.equal(p.proc.listenerCount('SIGWINCH'),0);assert.equal(p.counts.closed,1);
    p.proc.removeListener('newListener',fail);const retry=p.proc.stdout;assert(retry);assert.equal(p.owners.length,2);assert.equal(p.counts.started,2);return{sameError:true,closedOutput:p.counts.outputClosed,retry:true};
   }finally{p.proc.removeListener('newListener',fail);await p.close();}
  });
  await group('failed stderr registration preserves existing stdout signal consumer',async()=>{
   const p=platform(),original={stderr:true};try{const out=p.proc.stdout;p.proc.on('newListener',name=>{if(name==='SIGWINCH')throw original});let thrown;try{p.proc.stderr}catch(error){thrown=error}assert.equal(thrown,original);assert.equal(p.counts.created,1);assert.equal(p.counts.closed,0);assert.equal(helper.descriptor(p.owners[1]),-1);assert.equal(p.proc.listenerCount('SIGWINCH'),1);assert.equal(p.proc.stdout,out);return{sharedWrapRetained:true};}finally{p.proc.removeAllListeners('newListener');await p.close();}
  });
  await group('outer bind failure after public fd reuse retires captured owner only',async()=>{
   const p=platform(),original={binding:true};const file=fs.openSync(path.join(directory,'replacement'),'w+');const prior=Object.getOwnPropertyDescriptor(streams.Writable.prototype,'isTTY');try{
    Object.defineProperty(streams.Writable.prototype,'isTTY',{configurable:true,set(){assert.equal(helper.replace(file,1).error,0);throw original}});let thrown;try{p.proc.stdout}catch(error){thrown=error}assert.equal(thrown,original);assert.equal(helper.descriptor(p.owners[0]),-1);assert.equal(fs.fstatSync(1).ino,fs.fstatSync(file).ino);assert.equal(p.counts.started,0);return{sameError:true,replacementStillOpen:true};
   }finally{if(prior)Object.defineProperty(streams.Writable.prototype,'isTTY',prior);else delete streams.Writable.prototype.isTTY;assert.equal(helper.replace(restore,1).error,0);fs.closeSync(file);await p.close();}
  });
  await group('resize follows actual captured TTY after public fd replacement',async()=>{
   const p=platform();const file=fs.openSync(path.join(directory,'replacement'),'w+');try{const out=p.proc.stdout,err=p.proc.stderr;const owner=p.owners[0];assert.equal(helper.replace(file,1).error,0);const dimensions=await resize(out,err,93,31,helper.descriptor(owner));assert.deepEqual(dimensions,[93,31,93,31]);assert.equal(fs.fstatSync(1).ino,fs.fstatSync(file).ino);out.write(Buffer.from('OK'));return{dimensions,replacementStillOpen:true};}finally{assert.equal(helper.replace(restore,1).error,0);fs.closeSync(file);await p.close();}
  });
  await group('Worker environment does not install process SIGWINCH consumer',async()=>{
   const p=platform(false);try{p.proc.stdout;p.proc.stderr;assert.equal(p.counts.created,0);assert.equal(p.proc.listenerCount('SIGWINCH'),0);return{nativeSubscriptions:0,workerStdio:'existing separate gap'};}finally{await p.close();}
  });
 }
 const result={mode,rows,passed:rows.filter(row=>row.pass).length,failed:rows.filter(row=>!row.pass).length,scope:'Actual source consumer/publication and pinned process-signal algorithms over real native SignalWrap, captured OutputHandle and PTY; guest JSAPI/loop and Worker stdio remain separate'};
 fs.writeSync(reportFd,JSON.stringify(result)+'\n');process.exitCode=result.failed?1:0;
})().catch(error=>{fs.writeSync(reportFd,JSON.stringify({fatal:error.stack})+'\n');process.exitCode=1});
