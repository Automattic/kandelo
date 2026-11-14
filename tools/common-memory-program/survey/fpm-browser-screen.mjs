import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const [variants,profile,native,output]=process.argv.slice(2).map(p=>resolve(p));
if(existsSync(output))throw Error('choose a fresh output directory');mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(variants,'manifest.json'))),runs=[];
for(const [mode,{artifacts,ids}] of Object.entries(manifest.variants)) {
  const out=resolve(output,mode);mkdirSync(out);
  const args=['node_modules/playwright/cli.js','test','--config','tools/common-memory-program/platform/benchmark.config.ts','--max-failures=1'];
  const result=spawnSync(process.execPath,args,{env:{...process.env,KANDELO_BENCH_WARMUP:'64',
    KANDELO_COMMON_MEMORY_PROFILE:profile,KANDELO_COMMON_MEMORY_NATIVE_FPM:native,
    KANDELO_COMMON_MEMORY_FPM:artifacts.fpm.path,KANDELO_COMMON_MEMORY_ARTIFACTS:out},encoding:'utf8',timeout:2400000});
  writeFileSync(resolve(output,`${mode}.log`),(result.stdout??'')+(result.stderr??''));
  runs.push({mode,ids,args,exit:result.status,signal:result.signal,error:result.error?String(result.error):undefined});
  writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
  if(result.status!==0)throw Error(`${mode} browser timing screen failed`);
  console.log(`${mode}: 24 fresh-parent browser FPM controls passed`);
}
