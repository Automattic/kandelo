import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {verifyInputs} from './paired-inputs.mjs';
import {wordpressPairedInputs,wordpressPairedEnvironment,readWordpressPairedInputs} from './wordpress-paired-inputs.mjs';
const [host,...args]=process.argv.slice(2);
const [variants,profile,image,native,output]=args.slice(0,5).map(p=>resolve(p)),backend=args[5]??'sqlite';
if(!['node','browser','node-cpu'].includes(host))throw Error('host must be node, browser or node-cpu');
if(existsSync(output))throw Error('choose a fresh output directory');
const manifest=readWordpressPairedInputs(variants);
const frozen=wordpressPairedInputs(variants,profile,image,native,manifest,{backend,
  warmup:Number(process.env.KANDELO_SURVEY_WARMUP??2),rounds:Number(process.env.KANDELO_SURVEY_ROUNDS??5)});
if(host==='node-cpu')frozen.diagnostic='process-cpu';
mkdirSync(output,{recursive:true});
writeFileSync(resolve(output,'inputs.json'),JSON.stringify(frozen,null,2)+'\n');
if(host!=='browser') {
  const runs=[];
  for(const trial of frozen.plan) {
    const name=`node-${trial.cohort}-${trial.block}-${trial.order}-${trial.mode}-${trial.label}`,out=resolve(output,name);
    const artifact=trial.label==='native-file'?manifest.nativeArtifacts[trial.mode].path:manifest.variants[trial.mode].artifacts.fpm.path;
    const selectedProfile=frozen.hostProfiles[trial.mode];
    const entry=host==='node-cpu'?'wordpress-cpu.mjs':'wordpress-node.ts';
    const argv=['--import','tsx/esm',`tools/common-memory-program/survey/${entry}`,selectedProfile,image,artifact,out,trial.label,backend];
    const row={...trial,hostProfile:selectedProfile,appOptions:frozen.appOptions[trial.mode],output:out,startedAt:new Date().toISOString(),loadBefore:loadavg()};
    if(frozen.diagnostic)row.diagnostic=frozen.diagnostic;
    const run=spawnSync(process.execPath,argv,{env:{...process.env,...wordpressPairedEnvironment(frozen,trial.mode),KANDELO_SURVEY_SEED:String(trial.seed)},encoding:'utf8',timeout:320000});
    Object.assign(row,{exit:run.status,signal:run.signal,finishedAt:new Date().toISOString(),loadAfter:loadavg()});
    if(run.error)row.error=String(run.error);
    writeFileSync(resolve(output,name+'.log'),(run.stdout??'')+(run.stderr??''));
    runs.push(row);writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
    console.log(JSON.stringify(row));
    if(run.status!==0)throw Error(`paired WordPress control failed: ${name}`);
  }
} else {
  const argv=['node_modules/playwright/cli.js','test','--config','tools/common-memory-program/survey/wordpress-paired.config.ts','--max-failures=1'];
  const run=spawnSync(process.execPath,argv,{env:{...process.env,KANDELO_SURVEY_VARIANTS:variants,KANDELO_SURVEY_PAIRED_INPUTS:resolve(output,'inputs.json'),
    KANDELO_SURVEY_IMAGE:image,KANDELO_COMMON_MEMORY_ARTIFACTS:output},encoding:'utf8',timeout:3*3600000});
  writeFileSync(resolve(output,'run.log'),(run.stdout??'')+(run.stderr??''));
  writeFileSync(resolve(output,'run.json'),JSON.stringify({argv,exit:run.status,signal:run.signal,error:run.error?String(run.error):undefined},null,2)+'\n');
  if(run.status!==0)throw Error('paired WordPress browser controls failed');
}
verifyInputs(frozen.inputs);
console.log(`${host}: paired WordPress controls completed with frozen inputs`);
