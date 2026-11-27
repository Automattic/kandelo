// Host-only code-generator unit test. The imports below are an explicit test
// fixture; no kernel, process loader, Node FFI or fork acceptance is claimed.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
const directory=process.argv[2];
const cases=[
 ['u8',5,250,'getUint8','setUint8'],['s8',6,-7,'getInt8','setInt8'],
 ['u16',7,60000,'getUint16','setUint16'],['s16',8,-30000,'getInt16','setInt16'],
 ['u32',9,4000000000,'getUint32','setUint32'],['s32',10,-123456,'getInt32','setInt32'],
 ['u64',11,0xfedcba9876543210n,'getBigUint64','setBigUint64'],
 ['s64',12,-1234567890123n,'getBigInt64','setBigInt64'],
 ['f32',2,1.5,'getFloat32','setFloat32'],['f64',3,2.25,'getFloat64','setFloat64'],
 ['pointer',14,0x1234,'getUint32','setUint32'],
];
async function run(name,types,values,result,closure) {
 const memory=new WebAssembly.Memory({initial:2,maximum:65536,shared:true});
 const view=new DataView(memory.buffer);
 const table=new WebAssembly.Table({initial:32,element:'anyfunc'});
 const stack=new WebAssembly.Global({value:'i32',mutable:true},65536);
 const load=async(file,base,dispatch)=>WebAssembly.instantiate(await readFile(join(directory,file)),{env:{
   memory,__indirect_function_table:table,__stack_pointer:stack,
   __table_base:new WebAssembly.Global({value:'i32',mutable:false},base),
   kandelo_ffi_dispatch_closure:dispatch,
 }});
 const foreign=await WebAssembly.instantiate(await readFile(join(directory,`${name}-callee.wasm`)));
 table.set(16,foreign.instance.exports.entry);
 const call=(await load(`${name}-call.wasm`,3)).instance.exports.kandelo_ffi_call;
 const resultAddress=512,argsAddress=1024,valueAddress=2048;
 for(let i=0;i<types.length;i++) {
  view.setUint32(argsAddress+4*i,valueAddress+8*i,true);
  view[types[i][4]](valueAddress+8*i,values[i],true);
 }
 const expected=result[0]==='f64'&&types.length>1?values.reduce((n,v)=>n+Number(v),0):values[0];
 call(16,resultAddress,argsAddress);
 assert.equal(view[result[3]](resultAddress,true),expected,`${name} call`);
 assert.equal(stack.value,65536,`${name} call stack`);
 // ffi_arg-sized integer stores must initialize all four bytes for narrow
 // scalar returns, while floats and64-bit values retain their native width.
 if(result[0]==='s8'||result[0]==='s16')assert.equal(view.getInt32(resultAddress,true),expected);
 if(result[0]==='u8'||result[0]==='u16')assert.equal(view.getUint32(resultAddress,true),expected);
 call(16,0,argsAddress);assert.equal(stack.value,65536,`${name} discarded result`);
 let dispatches=0;
 const dispatch=(context,ret,args)=>{
  assert.equal(context,closure);
  const before=stack.value;
  assert.ok(before<65536);
  for(let i=0;i<types.length;i++) {
   const pointer=view.getUint32(args+4*i,true);
   assert.equal(view[types[i][3]](pointer,true),values[i],`${name} callback arg${i}`);
  }
  // Reenter another generated bridge on the same owning thread. Parent
  // callback argument/result storage must survive nested stack allocation.
  call(16,resultAddress,argsAddress);
  assert.equal(stack.value,before,`${name} nested stack`);
  view[result[4]](ret,expected,true);
  dispatches++;
 };
 const callback=(await load(`${name}-callback.wasm`,2,dispatch)).instance.exports.kandelo_ffi_callback;
 const reserve=(await load('reserve.wasm',1)).instance.exports;
 assert.equal(reserve.kandelo_ffi_slot(),1);
 assert.equal(table.get(1),null);
 reserve.kandelo_ffi_install(2);
 assert.equal(table.get(1),callback,'stable reservation points to typed callback');
 let returned=table.get(1)(...values);
 // The host JS API exposes i32/i64 as signed lanes; compare unsigned C
 // results by their declared bit width. Memory checks above retain all bits.
 if(result[0]==='u32'||result[0]==='pointer')returned>>>=0;
 if(result[0]==='u64')returned=BigInt.asUintN(64,returned);
 assert.equal(returned,expected,`${name} callback result`);
 assert.equal(dispatches,1);
 assert.equal(stack.value,65536,`${name} callback stack`);
}
for(const c of cases)await run(c[0],[c],[c[2]],c,4096+c[1]);
const f64=cases.find(c=>c[0]==='f64');
await run('triple',Array(3).fill(f64),[1.25,2.5,3.75],f64,8192);
await run('mixed',[...cases,f64,f64],[...cases.map(c=>c[2]),3.5,4.75],f64,8192);
await run('wide',Array(64).fill(f64),Array.from({length:64},(_,i)=>i+0.5),f64,8192);
console.log('14 host Wasm code-generation cases passed; no guest-loader/runtime acceptance claimed');
