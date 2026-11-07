'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),tty=require('node:tty'),helper=require(process.env.TTY_OUTPUT_COMPONENT);
const fd=Number(process.env.TTY_MASTER_FD),report=Number(process.env.REPORT_FD),mode=process.argv[2];
(async()=>{
 assert(tty.isatty(fd));const packet=helper.openOutput(fd);assert.notEqual(packet.error,0);assert.equal(packet.value,undefined);
 const output=mode==='candidate'?require('./platform.cjs').create(fd).output:new tty.WriteStream(fd);
 output._writableState.highWaterMark=1;let called=false,synchronous=true,callback;
 const result=output.cursorTo(2,3,error=>{callback={error:error===null?'null':typeof error,errorCode:error?.code??null,synchronous};called=true;});synchronous=false;
 const deadline=Date.now()+2000;while(!called&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));assert(called);
 fs.writeSync(report,JSON.stringify({mode,result,callback,actualNewOwnerRejectedUnsupportedMaster:true})+'\n');
 output.destroy();
})().catch(error=>{fs.writeSync(report,JSON.stringify({fatal:{message:error.message,stack:error.stack}})+'\n');process.exitCode=1;});
