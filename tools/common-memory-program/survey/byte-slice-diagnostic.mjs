// Component counters only. These profiled request latencies are never ranked.
import {spawnSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const [profile,output]=process.argv.slice(2).map(p=>resolve(p));
mkdirSync(output,{recursive:false});
const inputs=JSON.parse(readFileSync(resolve(profile,'profile-inputs.json')));
if(!inputs.byteSliceDiagnostics)throw Error('expected explicit diagnostic profile');
const vm=JSON.parse(readFileSync('.scratch/common-memory-survey-object-regions-1/manifest.json')).variants.baseline.artifacts.fpm.path;
const native=resolve('.scratch/common-memory-php-shared-build-1/out/php-fpm.wasm');
const runs=[];
for(const [backend,label] of [['sqlite','native-file'],['sqlite','vm-shared'],['mariadb','vm-shared']]) {
 const out=resolve(output,backend+'-'+label);
 const args=['--import','tsx/esm','tools/common-memory-program/survey/wordpress-node.ts',profile,
  resolve('.scratch/common-memory-wordpress-1/wordpress.vfs.zst'),label==='native-file'?native:vm,out,label,backend];
 const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:320000,
  env:{...process.env,KANDELO_SURVEY_WARMUP:'0',KANDELO_SURVEY_ROUNDS:'1'}});
 writeFileSync(out+'.log',(r.stdout??'')+(r.stderr??''));
 const result=JSON.parse(readFileSync(resolve(out,'result.json')));
 if(r.status!==0||!result.trial?.passed||!result.destroyed||result.diagnostics.length)throw Error('diagnostic request failed: '+backend+' '+label);
 const snapshots=result.trial.memory.map(m=>({phase:m.phase,...m.byteSlices}));
 if(snapshots.length<2)throw Error('missing diagnostic phases');
 for(let i=0;i<snapshots.length;i++)for(const field of ['bulk','fallback'])
  if(!Number.isSafeInteger(snapshots[i][field])||snapshots[i][field]<0||(i&&snapshots[i][field]<snapshots[i-1][field]))throw Error('invalid/nonmonotonic counter');
 if(label==='native-file'&&snapshots.some(m=>m.bulk||m.fallback))throw Error('ordinary control unexpectedly used virtual byte slices');
 runs.push({backend,label,args,exit:r.status,snapshots});
 writeFileSync(resolve(output,'result.json'),JSON.stringify({scope:'Kernel-Worker virtual byte-slice attempts only; excludes process Workers; diagnostics, not timing evidence',runs},null,2)+'\n');
 console.log(JSON.stringify(runs.at(-1)));
}
