import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {shortScalarSource} from '../platform/short-scalar-source.mjs';
const out=resolve(process.argv[2]);mkdirSync(out,{recursive:false});
const input='tools/common-memory-program/platform/memory.mjs',source=readFileSync(input,'utf8');
const hashes={};
for(const mode of ['baseline','dataview','typed']){
 const text=mode==='baseline'?source:shortScalarSource(source,{mode});
 const path=resolve(out,mode+'-memory.mjs');writeFileSync(path,text);hashes[mode]=createHash('sha256').update(text).digest('hex');
}
const paths=[input,'tools/common-memory-program/platform/short-scalar-source.mjs',
 'tools/common-memory-program/survey/short-scalar-checks.mjs','tools/common-memory-program/survey/short-scalar-worker.mjs',
 'tools/common-memory-program/survey/short-scalar.spec.ts','tools/common-memory-program/survey/short-scalar.config.ts',
 'tools/common-memory-program/survey/prepare-short-scalars.mjs'];
mkdirSync(resolve(out,'source'));const inputs={};
for(const p of paths){const b=readFileSync(p);inputs[p]=createHash('sha256').update(b).digest('hex');copyFileSync(p,resolve(out,'source',p.split('/').at(-1)));}
writeFileSync(resolve(out,'manifest.json'),JSON.stringify({scope:'TS-03 independent scalar adapter mechanisms',hashes,inputs},null,2)+'\n');
writeFileSync(resolve(out,'index.html'),`<!doctype html><title>TS-03 scalar checks</title><script type="module">
window.run=mode=>new Promise((resolve,reject)=>{const w=new Worker('/survey/short-scalar-worker.mjs',{type:'module'});const timer=setTimeout(()=>{w.terminate();reject(Error('short scalar deadline'));},120000);
w.onerror=e=>{clearTimeout(timer);w.terminate();reject(Error(e.message));};w.onmessage=({data})=>{clearTimeout(timer);w.terminate();data.error?reject(Error(data.error)):resolve({...data,crossOriginIsolated});};w.postMessage({mode});});</script>`);
console.log(JSON.stringify({out,hashes}));
