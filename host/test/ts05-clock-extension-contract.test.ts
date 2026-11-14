import{beforeAll,afterAll,describe,it,expect,vi}from'vitest';
import{mkdtempSync,writeFileSync,readFileSync,rmSync}from'node:fs';
import{execFileSync}from'node:child_process';
import{join}from'node:path';
import{tmpdir}from'node:os';
import{buildDlopenImports}from'../src/worker-main';
import{describeProgramExtensionFailures}from'../src/program-extensions';
import{describeWasmArtifactPolicyFailures,readWasmFunctionImports,readWasmImportDescriptors}from'../src/constants';
import{CLOCK_MODULE,CLOCK_IMPORT,CLOCK_FALLBACK}from'../src/generated/program-extensions';
let directory:string,bytes:ArrayBuffer;
beforeAll(()=>{
 directory=mkdtempSync(join(tmpdir(),'ts05-extension-'));
 const input=join(directory,'clock.wat'),output=join(directory,'clock.wasm');
 writeFileSync(input,`(module
 (import "env" "memory" (memory 1 1 shared))
 (import "${CLOCK_MODULE}" "${CLOCK_IMPORT}" (func $query (param i32 i32 i32) (result i32)))
 (func (export "run") (param i32 i32 i32) (result i32) local.get 0 local.get 1 local.get 2 call $query))`);
 execFileSync('wat2wasm',['--enable-threads',input,'-o',output]);bytes=Uint8Array.from(readFileSync(output)).buffer;
});
afterAll(()=>{if(directory)rmSync(directory,{recursive:true});});
function support(ownership:'copied'|'borrowed'='copied',query?: (pointer:number|bigint,id:number,format:number)=>number){
 const memory=new WebAssembly.Memory({initial:1,maximum:1,shared:true});
 const table=new WebAssembly.Table({initial:1,element:'anyfunc'});
 const stack=new WebAssembly.Global({value:'i32',mutable:true},32768);
 const value=buildDlopenImports(memory,4096,128,()=>table,()=>stack,()=>undefined,4,
  undefined,undefined,undefined,undefined,undefined,undefined,undefined,1,ownership,undefined,undefined,query);
 return{memory,value};
}
describe('private TS05 extension declaration and fallthrough only',()=>{
 it('admits a genuine pointer-matching function and refuses missing host support',()=>{
  expect(describeWasmArtifactPolicyFailures(bytes)).toEqual([]);
  const imports=readWasmImportDescriptors(bytes),functions=readWasmFunctionImports(bytes);
  expect(describeProgramExtensionFailures(imports,functions,[4])).toEqual([]);
  expect(describeProgramExtensionFailures(imports,functions,[4],new Set())).not.toEqual([]);
  expect(describeProgramExtensionFailures([],[],[4],new Set())).toEqual([]);
 });
 it('rejects unsupported versions, names, kinds and signatures',()=>{
  const imports=readWasmImportDescriptors(bytes),functions=readWasmFunctionImports(bytes);
  const altered=(patch:object)=>imports.map(i=>i.module===CLOCK_MODULE?{...i,...patch}:i);
  expect(describeProgramExtensionFailures(altered({module:'kandelo.clock.v2'}),functions,[4])).not.toEqual([]);
  expect(describeProgramExtensionFailures(altered({module:'env'}),functions,[4])).not.toEqual([]);
  expect(describeProgramExtensionFailures(altered({name:'unknown'}),functions,[4])).not.toEqual([]);
  expect(describeProgramExtensionFailures(altered({kind:'global'}),functions,[4])).not.toEqual([]);
  expect(describeProgramExtensionFailures(imports,functions,[8])).not.toEqual([]);
  expect(describeProgramExtensionFailures(imports,functions,[4,4])).not.toEqual([]);
  expect(describeProgramExtensionFailures(imports,functions.map(f=>({...f,signature:{params:[0x7f],results:[0x7f]}})),[4])).not.toEqual([]);
 });
 it('the real worker namespace falls through without touching output',async()=>{
  const{memory,value}=support();new Uint8Array(memory.buffer).fill(0xa5);
  const{instance}=await WebAssembly.instantiate(bytes,{env:{memory},...value.extensionImports});
  const run=instance.exports.run as(p:number,id:number,format:number)=>number;
  for(const[p,id,f]of[[1024,0,0],[65530,0,0],[-1,0,0],[1024,4,0],[1024,0,99]])expect(run(p,id,f)).toBe(CLOCK_FALLBACK);
  expect(new Uint8Array(memory.buffer).every(b=>b===0xa5)).toBe(true);
 });
 it('borrowed memory cannot invoke a supplied query capability',()=>{
  const query=vi.fn(()=>0),borrowed=support('borrowed',query);
  const fn=borrowed.value.extensionImports[CLOCK_MODULE][CLOCK_IMPORT] as Function;
  expect(fn(1024,0,0)).toBe(CLOCK_FALLBACK);expect(query).not.toHaveBeenCalled();
  const copied=support('copied',query);const owned=copied.value.extensionImports[CLOCK_MODULE][CLOCK_IMPORT] as Function;
  expect(owned(1024,0,0)).toBe(0);expect(query).toHaveBeenCalledExactlyOnceWith(1024,0,0);
 });
});
