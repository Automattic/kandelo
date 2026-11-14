import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const [variants,profile,native,output]=process.argv.slice(2).map(p=>resolve(p));
if(existsSync(output))throw Error('choose a fresh output directory');mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(variants,'manifest.json'))),runs=[];
for(const [mode,{artifacts,ids}] of Object.entries(manifest.variants)) {
  const out=resolve(output,mode),args=['tools/common-memory-program/platform/benchmark-run-node.mjs',profile,native,artifacts.fpm.path,out];
  const result=spawnSync(process.execPath,args,{env:{...process.env,KANDELO_BENCH_WARMUP:'64'},encoding:'utf8',timeout:1800000});
  writeFileSync(resolve(output,`${mode}.log`),(result.stdout??'')+(result.stderr??''));
  runs.push({mode,ids,args,exit:result.status,signal:result.signal,error:result.error?String(result.error):undefined});
  writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
  if(result.status!==0)throw Error(`${mode} timing screen failed`);
  console.log(`${mode}: eight fresh-parent FPM controls passed`);
}
