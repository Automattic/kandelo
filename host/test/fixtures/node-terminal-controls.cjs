const fs=require('node:fs'),tty=require('node:tty'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const mode=process.argv[2],name=process.argv[3],device=process.argv[4],probe=process.argv[5];
async function main(){
 const fd=fs.openSync(device,fs.constants.O_RDWR|fs.constants.O_NOCTTY);
 const owner=mode==='candidate'?require('./node-terminal-platform.cjs').create(fd):undefined;
 const input=owner?owner.input:new tty.ReadStream(fd);let result;
 async function close(){if(!input.destroyed){const done=new Promise(resolve=>input.once('close',resolve));input.destroy();await done;}if(owner)await owner.settle();}
 try{
  if(name==='modes'){
   result=[];for(const value of [true,'io',false,'raw',null,undefined,1,0,{},Symbol('raw')]){
    const returned=input.setRawMode(value);result.push([returned===input,input.isRaw,input.rawMode]);
   }
  }else if(name==='validation'){
   input.setRawMode('io');result=[];
   for(const value of ['','RAW','normal','false']){let caught;try{input.setRawMode(value);}catch(error){caught={name:error.name,code:error.code,message:error.message};}
    assert(caught);result.push({caught,isRaw:input.isRaw,rawMode:input.rawMode});}
   result.push({name:input.setRawMode.name,length:input.setRawMode.length});
  }else if(name==='nativeFailure'){
   const actual=owner?owner.actual:input;await new Promise(resolve=>actual._handle.close(resolve));
   const errors=[];input.on('error',error=>errors.push({name:error.name,code:error.code,errno:error.errno,syscall:error.syscall,message:error.message}));
   const returned=input.setRawMode(true);result={same:returned===input,isRaw:input.isRaw,rawMode:input.rawMode,errors};assert.equal(errors.length,1);
  }else if(name==='manualNotification'){
   input.setRawMode('raw');input.emit('close');input.setRawMode('io');
   const state=require('node:child_process').spawnSync(probe,[device,'snapshot'],{encoding:'utf8'});
   assert.equal(state.status,0);result={state:JSON.parse(state.stdout),isRaw:input.isRaw,rawMode:input.rawMode};
  }else if(name==='closeAndBorrow'){
   input.setRawMode('raw');await close();const returned=input.setRawMode('io');
   const other=new EventEmitter();input.setRawMode.call(other,false);
   result={same:returned===input,isRaw:input.isRaw,rawMode:input.rawMode,other:[other.isRaw,other.rawMode]};
  }else throw Error('Unknown case');
  console.log(JSON.stringify(result));
 }finally{await close();fs.fstatSync(fd);fs.closeSync(fd);}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
