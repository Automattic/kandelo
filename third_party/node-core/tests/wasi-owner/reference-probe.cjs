'use strict';
const {WASI}=require('node:wasi');
const fs=require('node:fs'),path=require('node:path');
const tag=process.argv[2];
function u(n){const out=[];do{const b=n&127;n>>>=7;out.push(b|(n?128:0));}while(n);return out;}
const str=s=>{const b=Buffer.from(s);return[...u(b.length),...b]};const sec=(id,b)=>[id,...u(b.length),...b];
function module(){return new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0,...sec(1,[2,96,2,127,127,1,127,96,0,1,127]),...sec(2,[1,...str('wasi_snapshot_preview1'),...str('args_sizes_get'),0,0]),...sec(3,[1,1]),...sec(5,[1,0,1]),...sec(7,[2,...str('run'),0,1,...str('memory'),2,0]),...sec(10,[1,8,0,65,127,65,0,16,0,11])]));}
if(tag==='reflection'){
 const w=new WASI({version:'preview1'});console.log(JSON.stringify({own:Object.getOwnPropertyNames(w.wasiImport),proto:Object.getOwnPropertyNames(Object.getPrototypeOf(w.wasiImport)),ctor:w.wasiImport.constructor.name,fdWriteName:w.wasiImport.fd_write.name,fdWriteLength:w.wasiImport.fd_write.length,setMemoryPresent:'_setMemory'in w.wasiImport,methods:Object.keys(w.wasiImport)}));
}else if(tag==='types'){
 const w=new WASI({version:'preview1'}),memory=new WebAssembly.Memory({initial:1});const before=[];for(const a of [[],[-1,0],[0,0],[0.1,0],[0,0,0]])try{before.push(w.wasiImport.args_sizes_get(...a));}catch(e){before.push({code:e.code,message:e.message});}w.finalizeBindings({exports:{memory}});const after=[];for(const a of [[],[-1,0],[0,0],[0.1,0],[0,0,0],[2**32,0]])try{after.push(w.wasiImport.args_sizes_get(...a));}catch(e){after.push({code:e.code,message:e.message});}console.log(JSON.stringify({before,after}));
}else if(tag==='wasm-negative'){
 const w=new WASI({version:'preview1'}),instance=new WebAssembly.Instance(module(),w.getImportObject());w.finalizeBindings(instance);console.log(JSON.stringify({actualWasmResult:instance.exports.run(),directJSResult:w.wasiImport.args_sizes_get(-1,0)}));
}else if(tag==='shared'){
 const memory=new WebAssembly.Memory({initial:1,maximum:3,shared:true}),w=new WASI({version:'preview1',args:['one']});w.finalizeBindings({exports:{memory}});let first=w.wasiImport.args_sizes_get(0,4);memory.grow(1);let next=w.wasiImport.args_sizes_get(65536,65540);console.log(JSON.stringify({first,next,bytes:memory.buffer.byteLength,argc:new DataView(memory.buffer).getUint32(65536,true)}));
}else if(tag==='stdio-bad'){
 try{new WASI({version:'preview1',stdin:999999});console.log('success');}catch(e){console.log(JSON.stringify({name:e.name,code:e.code,errno:e.errno,syscall:e.syscall,message:e.message}));}
}else if(tag==='rights'){
 const file=path.join(process.env.WASI_OWNER_CONTROL_DIR,'rights-native.txt');const fd=fs.openSync(file,'w+'),w=new WASI({version:'preview1',stdin:fd,stdout:fd,stderr:fd,preopens:{'/guest':__dirname}}),memory=new WebAssembly.Memory({initial:1});w.finalizeBindings({exports:{memory}});const out=[];for(const n of[0,1,2,3]){const err=w.wasiImport.fd_fdstat_get(n,0),v=new DataView(memory.buffer);out.push({fd:n,err,type:v.getUint8(0),flags:v.getUint16(2,true),base:String(v.getBigUint64(8,true)),inherit:String(v.getBigUint64(16,true))});}console.log(JSON.stringify(out));fs.closeSync(fd);fs.unlinkSync(file);
}
