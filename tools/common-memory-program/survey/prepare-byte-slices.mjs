import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {byteSliceSource} from '../platform/byte-slice-source.mjs';
const out=resolve(process.argv[2]);await mkdir(out,{recursive:false});
const input='tools/common-memory-program/platform/memory.mjs',source=await readFile(input,'utf8');
await writeFile(resolve(out,'baseline-memory.mjs'),source);
await writeFile(resolve(out,'candidate-memory.mjs'),byteSliceSource(source,{diagnostics:true}));
await copyFile('tools/common-memory-program/platform/byte-slices.mjs',resolve(out,'byte-slices.mjs'));
const paths=[input,'tools/common-memory-program/platform/byte-slices.mjs','tools/common-memory-program/platform/byte-slice-source.mjs',
 'tools/common-memory-program/survey/prepare-byte-slices.mjs','tools/common-memory-program/survey/byte-slice-checks.mjs',
 'tools/common-memory-program/survey/byte-slice-node.mjs','tools/common-memory-program/survey/byte-slice-worker.mjs',
 'tools/common-memory-program/survey/byte-slice.spec.ts','tools/common-memory-program/survey/byte-slice.config.ts'];
await mkdir(resolve(out,'source'));
const inputs={};for(const path of paths){
 const bytes=await readFile(path);inputs[path]=createHash('sha256').update(bytes).digest('hex');
 await writeFile(resolve(out,'source',path.split('/').at(-1)),bytes);
}
await writeFile(resolve(out,'inputs.json'),JSON.stringify({scope:'VM-05 byte snapshot mechanism, diagnostic counters enabled; no timings',inputs},null,2)+'\n');
await writeFile(resolve(out,'index.html'),`<!doctype html><meta charset="utf-8"><script type="module">
window.run=()=>new Promise((resolve,reject)=>{const w=new Worker('/survey/byte-slice-worker.mjs',{type:'module'});
const timer=setTimeout(()=>{w.terminate();reject(Error('byte slice probe deadline'));},120000);
w.onerror=e=>{clearTimeout(timer);w.terminate();reject(Error(e.message));};
w.onmessage=({data})=>{clearTimeout(timer);w.terminate();data.error?reject(Error(data.error)):resolve({...data,crossOriginIsolated});};
w.postMessage({});});</script>`);
console.log(out);
