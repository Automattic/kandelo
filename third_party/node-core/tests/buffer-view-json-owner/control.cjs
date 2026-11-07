const path=require('node:path');
const mode=process.argv[2],repo=process.argv[3];const B=mode==='native'?require('node:buffer').Buffer:require(path.join(repo,'host/test/fixtures/node-buffer-pool.cjs')).create().Buffer;
const rows=[];
function run(name,fn){try{rows.push({name,result:fn()});}catch(error){rows.push({name,unexpected:{name:error.name,code:error.code,message:error.message}});}}
function outcome(fn){try{const v=fn();return{value:v};}catch(error){return{error:{name:error.name,code:error.code,message:error.message}};}}
function view(b,source){return{bytes:Array.from(b),length:b.length,offset:b.byteOffset-(source?.byteOffset||0),shares:source?b.buffer===source.buffer:undefined,buffer:B.isBuffer(b),constructor:b.constructor===B};}
run('tojson-standard',()=>[B.from([1,2,255]).toJSON(),B.alloc(0).toJSON(),JSON.parse(JSON.stringify(B.from([65,66])))]);
run('tojson-intrinsic-iteration',()=>{const b=B.from([1,2,3]);let called=0;b[Symbol.iterator]=()=>{called++;throw Error('iterator must not run');};Object.defineProperty(b,'length',{get(){throw Error('length must not run');}});return{value:b.toJSON(),called};});
run('tojson-generic-typed-receivers',()=>[new Uint16Array([1,257]),new DataView(new ArrayBuffer(2)),{},null].map(value=>outcome(()=>B.prototype.toJSON.call(value))));
run('view-default-alias',()=>{const b=B.from([1,2,3,4]);const s=b.subarray(1,3);s[0]=9;const t=b.slice(2);b[2]=8;return{source:Array.from(b),sub:view(s,b),slice:view(t,b)};});
run('constructor-species-not-consulted',()=>{const b=B.from([1,2,3]);let called=0;Object.defineProperty(b,'constructor',{get(){called++;throw Error('constructor must not run');}});const s=b.subarray(1);return{called,bytes:Array.from(s),buffer:B.isBuffer(s)};});
run('slice-dispatches-public-subarray',()=>{const b=B.from([1,2,3]);const sentinel={sentinel:true};let receiver=false,args;b.subarray=function(...a){receiver=this===b;args=a;return sentinel;};return{identity:b.slice(1,2)===sentinel,receiver,args};});
run('view-public-accessor-order',()=>{const b=B.from([1,2,3,4]);const target=new Uint8Array([10,11,12,13,14,15]);const log=[];Object.defineProperties(b,{buffer:{get(){log.push('buffer');return target.buffer;}},byteOffset:{get(){log.push('offset');return 1;}},length:{get(){throw Error('own length must not run');}}});const s=b.subarray({valueOf(){log.push('start');return 1;}},{valueOf(){log.push('end');return 3;}});return{log,bytes:Array.from(s),offset:s.byteOffset,shares:s.buffer===target.buffer};});
run('offset-coercions',()=>{const b=B.from([1,2,3,4]);return[undefined,null,NaN,Infinity,-Infinity,2**40,-(2**40),1.5,-1.5,'2',1n,Symbol('offset')].map(start=>outcome(()=>Array.from(b.subarray(start,3))));});
run('end-coercions',()=>{const b=B.from([1,2,3,4]);return[undefined,null,NaN,Infinity,-Infinity,2**40,-(2**40),1.5,-1.5,'2',1n,Symbol('offset')].map(end=>outcome(()=>Array.from(b.subarray(1,end))));});
run('original-offset-throw',()=>{const b=B.from([1,2]);const original={sentinel:true};let identity=false;try{b.subarray({valueOf(){throw original;}});}catch(error){identity=error===original;}return{identity};});
run('method-descriptors',()=>Object.fromEntries(['toJSON','slice','subarray'].map(key=>{const d=Object.getOwnPropertyDescriptor(B.prototype,key);return[key,{enumerable:d.enumerable,writable:d.writable,configurable:d.configurable,name:d.value.name,length:d.value.length}];})));
run('detached-source',()=>{const ab=new ArrayBuffer(4),b=B.from(ab);structuredClone(ab,{transfer:[ab]});return{json:outcome(()=>b.toJSON()),sub:outcome(()=>Array.from(b.subarray())),slice:outcome(()=>Array.from(b.slice()))};});
run('resizable-out-of-bounds-view',()=>{const ab=new ArrayBuffer(8,{maxByteLength:16});const b=B.from(ab,2,4);ab.resize(3);return{json:b.toJSON(),view:view(b.subarray(),b)};});
run('reentrant-resize-before-construction',()=>{const ab=new ArrayBuffer(8,{maxByteLength:16}),b=B.from(ab);return outcome(()=>Array.from(b.subarray({valueOf(){ab.resize(2);return 1;}})));});
console.log(JSON.stringify(rows));
