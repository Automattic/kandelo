import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {wordpressPlan} from './wordpress-plan.mjs';
import {wordpressInputs,wordpressIdentities,verifyWordpressInputs} from './wordpress-inputs.mjs';
const [variants,profile,image,native,output,backend='sqlite']=process.argv.slice(2).map((v,i)=>i<5?resolve(v):v);
if(existsSync(output))throw Error('choose a fresh output directory');mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(variants,'manifest.json')));
const modes=(process.env.KANDELO_SURVEY_MODES??'baseline,baseline-conditional,scalar,scalar-conditional').split(',');
const plan=wordpressPlan(modes),inputs=wordpressInputs(variants,profile,image,native,manifest,modes);
writeFileSync(resolve(output,'inputs.json'),JSON.stringify({inputs,plan,backend,runtime:process.version,flags:process.execArgv,
  identities:wordpressIdentities(inputs,image,native,manifest,modes)},null,2)+'\n');
const runs=[];
for(const trial of plan) {
  const artifact=trial.label==='native-file'?native:manifest.variants[trial.mode].artifacts.fpm.path;
  const name=`node-${trial.cohort}-${trial.order}-${trial.mode}-${trial.label}`,out=resolve(output,name);
  const args=['--import','tsx/esm','tools/common-memory-program/survey/wordpress-node.ts',profile,image,artifact,out,trial.label,backend];
  const run={...trial,output:out,loadBefore:loadavg(),startedAt:new Date().toISOString()};
  const result=spawnSync(process.execPath,args,{env:{...process.env,KANDELO_SURVEY_SEED:String(trial.seed)},encoding:'utf8',timeout:320000});
  Object.assign(run,{exit:result.status,signal:result.signal,loadAfter:loadavg(),finishedAt:new Date().toISOString()});
  if(result.error)run.error=String(result.error);
  writeFileSync(resolve(output,name+'.log'),(result.stdout??'')+(result.stderr??''));
  runs.push(run);writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
  console.log(JSON.stringify(run));
  if(result.status!==0)throw Error(`WordPress trial failed: ${name}`);
}
verifyWordpressInputs(inputs);
console.log('Matched WordPress controls passed with frozen inputs.');
