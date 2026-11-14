// Application correctness only: deliberately no performance ranking from
// this short, un-warmed run or from concurrently running browser checks.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {wordpressPlan} from './wordpress-plan.mjs';
const [variants,profile,image,native,output]=process.argv.slice(2).map(p=>resolve(p));
if(existsSync(output))throw Error('choose a fresh output directory');mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(variants,'manifest.json'))),runs=[];
const plan=wordpressPlan(Object.keys(manifest.variants)).filter(t=>t.cohort===0&&(t.order===0||t.label==='vm-shared'));
for(const backend of ['sqlite','mariadb'])for(const trial of plan) {
  const artifact=trial.label==='native-file'?native:manifest.variants[trial.mode].artifacts.fpm.path;
  const name=`${backend}-${trial.mode}-${trial.label}`,out=resolve(output,name);
  const args=['--import','tsx/esm','tools/common-memory-program/survey/wordpress-node.ts',profile,image,artifact,out,trial.label,backend];
  const result=spawnSync(process.execPath,args,{env:{...process.env,KANDELO_SURVEY_WARMUP:'0',KANDELO_SURVEY_ROUNDS:'1'},encoding:'utf8',timeout:320000});
  writeFileSync(resolve(output,name+'.log'),(result.stdout??'')+(result.stderr??''));
  runs.push({backend,...trial,args,output:out,exit:result.status,signal:result.signal,error:result.error?String(result.error):undefined});
  writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
  if(result.status!==0)throw Error(`WordPress correctness check failed: ${name}`);
  console.log(`${name}: homepage/article/admin/REST and cache checks passed`);
}
