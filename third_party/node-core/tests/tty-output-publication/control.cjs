'use strict';
const fs=require('node:fs'),path=require('node:path'),util=require('node:util'),os=require('node:os');
const assert=require('node:assert/strict'),stream=require('node:stream'),tty=require('node:tty'),readline=require('node:readline');
const base=fs.realpathSync(process.env.TTY_OUTPUT_PUBLICATION_DIR);
assert.equal(base,path.resolve(process.env.TTY_OUTPUT_PUBLICATION_DIR));
const mode=process.argv[2],helper=require(path.join(base,'component/window.node'));
assert.equal(process.version,'v26.13.0');assert(tty.isatty(1));
const factories=Function(fs.readFileSync(path.join(base,'controls-'+mode+'-core.js'),'utf8')+';return {values:_createNodeValuesPlatform,fd:_createNodeFdStreamPlatform,terminal:_createNodeTerminalPlatform};')();
const values=factories.values({process,Buffer,util,inspection:util,os,signals:os.constants.signals,getDOMException:()=>DOMException});
const rows=[];let captured,closeCalls=0,closeThrows=false;
const terminal=factories.terminal({values,native:{operatingSystem(operation,...args){
 if(operation==='tty-output-open'){const packet=helper.openOutput(...args);if(!packet.error)captured=packet.value;return packet;}
 if(operation==='tty-output-close'){closeCalls++;const packet=helper.closeOutput(...args);if(closeThrows)throw Error('authored post-close boundary exception');return packet;}
 if(operation==='tty-output-write')return helper.writeOutput(...args);
 if(operation==='tty-output-size')return helper.outputSize(...args);
 if(operation==='tty-size')return helper.windowSize(...args);
 throw Error('Unexpected genuine terminal operation: '+operation);
}},uv:{getSystemErrorName:util.getSystemErrorName,getSystemErrorMessage:util.getSystemErrorMessage},isTTY:tty.isatty,getReadline:()=>readline});
const fd=factories.fd({stream,Buffer,process,openTerminalOutput:terminal.openOutput,native:{__kandeloFdWrite(){throw Error('unexpected generic fd transport for real PTY');}}});
const flags=n=>helper.nonblocking(n);
async function test(name,body){captured=undefined;closeCalls=0;closeThrows=false;try{await body();rows.push({name,status:'pass'});}catch(error){rows.push({name,status:'fail',error:error.stack});}finally{if(captured)helper.closeOutput(captured);}}
(async()=>{
 await test('options getter preserves thrown identity and closes captured owner',()=>{
  const original=Object.freeze({original:'options'});let thrown;
  try{fd.writable(1,{get highWaterMark(){throw original}})}catch(error){thrown=error}
  assert.equal(thrown,original);assert(captured);assert.equal(helper.descriptor(captured),-1);assert.equal(closeCalls,1);assert.equal(flags(1).error,0);
 });
 await test('actual Writable validation failure retires prior native acquisition',()=>{
  let thrown;try{fd.writable(1,{highWaterMark:-1})}catch(error){thrown=error}
  assert.equal(thrown.code,'ERR_INVALID_ARG_VALUE');assert.equal(helper.descriptor(captured),-1);assert.equal(closeCalls,1);assert.equal(flags(1).error,0);
 });
 await test('real public prototype fd setter failure closes acquired output',()=>{
  const original=Object.freeze({original:'fd setter'});let escaped,thrown;
  const descriptor=Object.getOwnPropertyDescriptor(stream.Writable.prototype,'fd');
  Object.defineProperty(stream.Writable.prototype,'fd',{configurable:true,set(){escaped=this;throw original}});
  try{try{fd.writable(1)}catch(error){thrown=error}}finally{if(descriptor)Object.defineProperty(stream.Writable.prototype,'fd',descriptor);else delete stream.Writable.prototype.fd;}
  assert(escaped instanceof stream.Writable);assert.equal(thrown,original);assert.equal(helper.descriptor(captured),-1);assert.equal(closeCalls,1);assert.equal(flags(1).error,0);
 });
 await test('failed publication closes extra owner after public fd replacement',()=>{
  const original=Object.freeze({original:'replaced fd'});let thrown;
  const descriptor=Object.getOwnPropertyDescriptor(stream.Writable.prototype,'fd');
  assert.equal(fs.realpathSync(base),base);
  const replacement=fs.openSync(path.join(base,'replacement-file'),'w+');
  const restore=Number(process.env.RESTORE_FD);
  Object.defineProperty(stream.Writable.prototype,'fd',{configurable:true,set(){
    assert.equal(helper.replace(replacement,1).error,0);throw original;
  }});
  try {
    try{fd.writable(1)}catch(error){thrown=error}
    assert.equal(thrown,original);assert.equal(helper.descriptor(captured),-1);assert.equal(closeCalls,1);
    assert.equal(fs.fstatSync(1).ino,fs.fstatSync(replacement).ino);assert.equal(flags(1).error,0);
  } finally {
    if(descriptor)Object.defineProperty(stream.Writable.prototype,'fd',descriptor);else delete stream.Writable.prototype.fd;
    assert.equal(helper.replace(restore,1).error,0);fs.closeSync(replacement);
  }
 });
 await test('cleanup failure cannot replace original publication exception',()=>{
  const original=Object.freeze({original:'cleanup throws'});let thrown;closeThrows=true;
  try{fd.writable(1,{get highWaterMark(){throw original}})}catch(error){thrown=error}
  assert.equal(thrown,original);assert.equal(helper.descriptor(captured),-1);assert.equal(closeCalls,1);assert.equal(flags(1).error,0);
 });
 await test('successful write and stdio destroy retain genuine native owner',async()=>{
  const output=fd.writable(1);const owned=helper.descriptor(captured);assert(owned>2);assert.equal(closeCalls,0);
  const result=output.write(Buffer.from('OK'));assert.equal(typeof result,'boolean');assert.equal(helper.descriptor(captured),owned);
  output.destroy();await new Promise(resolve=>process.nextTick(resolve));assert.equal(helper.descriptor(captured),owned);assert.equal(flags(1).error,0);assert.equal(closeCalls,0);
 });
 const report={scope:'actual source-backed production factories and current OutputHandle over real native PTY; native Writable/errors/NAPI bridge are explicit dependencies, not guest JSAPI/close-loop proof',mode,rows,pass:rows.filter(x=>x.status==='pass').length,fail:rows.filter(x=>x.status==='fail').length};
 fs.writeSync(Number(process.env.REPORT_FD),JSON.stringify(report)+'\n');process.exitCode=report.fail?1:0;
})().catch(error=>{fs.writeSync(Number(process.env.REPORT_FD),JSON.stringify({fatal:error.stack})+'\n');process.exitCode=1});
