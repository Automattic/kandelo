// This import-free Wasm is a standalone source-isolated callback ABI fixture.
import{readFile}from'node:fs/promises';import assert from'node:assert/strict';
const[base,after]=process.argv.slice(2);for(const[path,before]of[[base,true],[after,false]]){
 const bytes=await readFile(path),module=new WebAssembly.Module(bytes);assert.deepEqual(WebAssembly.Module.imports(module),[]);
 for(let n=0;n<17;n++){const instance=new WebAssembly.Instance(module,{});const{exports}=instance;if(before&&(n<6||(n>=9&&n<15)))assert.throws(()=>exports.run_case(n),error=>error instanceof WebAssembly.RuntimeError&&/signature mismatch|indirect call type mismatch/i.test(error.message));else assert.equal(exports.run_case(n),1,'case'+n);}
 console.log((before?'before':'after')+':17 exact source-isolated ABI cases judged');
}
