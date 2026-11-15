import{spawnSync}from'node:child_process';import{readFileSync,writeFileSync,mkdirSync,existsSync}from'node:fs';import{resolve}from'node:path';import{createHash}from'node:crypto';import{loadavg}from'node:os';
import{wordpressPairedInputs,wordpressPairedEnvironment,readWordpressPairedInputs}from'./wordpress-paired-inputs.mjs';import{verifyInputs}from'./paired-inputs.mjs';import{wordpressPreloadPlan}from'./wordpress-preload-plan.mjs';
const[host,...args]=process.argv.slice(2),[variants,profile,image,native,output]=args.slice(0,5).map(p=>resolve(p)),backend=args[5]??'sqlite';
if(!['node','browser'].includes(host)||backend!=='sqlite')throw Error('bounded screen supports node/browser SQLite');if(existsSync(output))throw Error('choose fresh output');
const manifest=readWordpressPairedInputs(variants),frozen=wordpressPairedInputs(variants,profile,image,native,manifest,{backend,warmup:2,rounds:5});
if(Object.values(frozen.appOptions).some(o=>o.validateTimestamps!==false))throw Error('preload first screen requires explicit immutable-code timestamp policy for every case');
frozen.plan=wordpressPreloadPlan(manifest);frozen.scope='APP01 plain SQLite preload alone and after small-fusion/byte preset. Matched shared-cache VM pairs, two reversed orders, own-profile ordinary FILE references explicitly unpreloaded/non-feature-equivalent. Immutable timestamps off, two warmup/five measured rounds; no pure translation-tax or platform claim.';
for(const p of manifest.provenanceFiles??[])frozen.inputs[resolve(p)]=createHash('sha256').update(readFileSync(p)).digest('hex');
mkdirSync(output,{recursive:false});writeFileSync(resolve(output,'inputs.json'),JSON.stringify(frozen,null,2)+'\n');
if(host==='node'){
 const runs=[];for(const trial of frozen.plan){
  const name=`node-${trial.cohort}-${trial.block}-${trial.order}-${trial.mode}-${trial.label}`,out=resolve(output,name),artifact=trial.label==='native-file'?manifest.nativeArtifacts[trial.mode].path:manifest.variants[trial.mode].artifacts.fpm.path;
  const argv=['--import','tsx/esm','tools/common-memory-program/survey/wordpress-node.ts',frozen.hostProfiles[trial.mode],image,artifact,out,trial.label,backend],row={...trial,output:out,startedAt:new Date().toISOString(),loadBefore:loadavg()};
  const r=spawnSync(process.execPath,argv,{env:{...process.env,...wordpressPairedEnvironment(frozen,trial.mode),KANDELO_SURVEY_SEED:String(trial.seed)},encoding:'utf8',timeout:320000});Object.assign(row,{exit:r.status,signal:r.signal,finishedAt:new Date().toISOString(),loadAfter:loadavg(),...(r.error?{error:String(r.error)}:{})});writeFileSync(resolve(output,name+'.log'),(r.stdout??'')+(r.stderr??''));runs.push(row);writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');console.log(JSON.stringify(row));if(r.status!==0)throw Error('preload control failed: '+name);
 }
}else{
 const argv=['node_modules/playwright/cli.js','test','--config','tools/common-memory-program/survey/wordpress-paired.config.ts','--max-failures=1'];const r=spawnSync(process.execPath,argv,{env:{...process.env,KANDELO_SURVEY_VARIANTS:variants,KANDELO_SURVEY_PAIRED_INPUTS:resolve(output,'inputs.json'),KANDELO_SURVEY_IMAGE:image,KANDELO_COMMON_MEMORY_ARTIFACTS:output},encoding:'utf8',timeout:3600000});writeFileSync(resolve(output,'run.log'),(r.stdout??'')+(r.stderr??''));writeFileSync(resolve(output,'run.json'),JSON.stringify({argv,exit:r.status,signal:r.signal,error:r.error?String(r.error):undefined},null,2)+'\n');if(r.status!==0)throw Error('preload browser controls failed');
}
verifyInputs(frozen.inputs);console.log(host+': preload controls completed; frozen inputs unchanged');
