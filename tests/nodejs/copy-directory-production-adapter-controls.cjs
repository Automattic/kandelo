'use strict';
// Complete production prefix, forwarding-only boundary. The supplied native
// spies observe identity/order/exception propagation; they are not I/O proof.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(process.argv[2],'utf8');
const names=['cpSyncCheckPaths','cpSyncOverrideFile','cpSyncCopyDir','createCpDirJob','runCpDirJob'];
const calls=[];const marker={marker:true};const rejection=new Error('actual native rejection');
const native={};
for(const name of names)native[name]=function(...args){
 assert.equal(this,native);calls.push([name,args]);
 if(args[0]===rejection)throw rejection;
 return marker;
};
const context=vm.createContext({__kandeloNodeNative:native,TextEncoder,TextDecoder,queueMicrotask,scriptArgs:[],scriptPath:''});
const adapter=vm.runInContext(source+'\nreturn _nodeNative;\n})()',context);
const noCoerce={valueOf(){throw new Error('must not coerce');},toString(){throw new Error('must not stringify');}};
for(const name of names){
 const args=name==='runCpDirJob'?[noCoerce]:[noCoerce,undefined,null,marker];
 assert.equal(Reflect.apply(adapter[name],adapter,args),marker);
 const record=calls[calls.length-1];assert.equal(record[0],name);assert.equal(record[1].length,args.length);
 for(let i=0;i<args.length;i++)assert.equal(record[1][i],args[i]);
 assert.throws(()=>adapter[name](rejection),e=>e===rejection);
}
console.log(JSON.stringify({passed:true,names,scope:'production prefix forwarding only'}));
