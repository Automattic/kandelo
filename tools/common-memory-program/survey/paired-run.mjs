import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
import {pairedPlan} from './paired-plan.mjs';
import {freezeInputs,verifyInputs,hostProfileFor,hostProfileBindings} from './paired-inputs.mjs';
const [host,...paths]=process.argv.slice(2),[variants,profile,native,output]=paths.map(p=>resolve(p));
if(!['node','browser'].includes(host))throw Error('host must be node or browser');
if(existsSync(output))throw Error('choose a fresh output directory');mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(variants,'manifest.json'))),plan=pairedPlan(manifest);
const inputs=freezeInputs(variants,profile,manifest,native);
const hostProfiles=hostProfileBindings(manifest,profile);
const expectedArtifacts={vm:Object.fromEntries(Object.entries(manifest.variants).map(([mode,v])=>[mode,v.artifacts.fpm.sha256])),
  native:manifest.nativeArtifacts?Object.fromEntries(Object.entries(manifest.nativeArtifacts).map(([mode,v])=>[mode,v.sha256])):{native:inputs[native]}};
writeFileSync(resolve(output,'inputs.json'),JSON.stringify({inputs,plan,runtime:process.version,flags:process.execArgv,
  expectedArtifacts,...(manifest.nativeArtifacts?{nativeArtifacts:manifest.nativeArtifacts}:{}),
  ...(hostProfiles?{hostProfiles,hostProfileArtifacts:manifest.profileArtifacts}:{})},null,2)+'\n');
if(host==='node') {
  const runs=[];
  for(const trial of plan) {
    const name=`node-${trial.cohort}-${trial.block}-${trial.order}-${trial.mode}-${trial.label}`,out=resolve(output,name);
    const ordinary=manifest.nativeArtifacts?.[trial.mode]?.path??native;
    const selectedProfile=hostProfileFor(manifest,trial.mode,profile);
    const args=['tools/common-memory-program/platform/benchmark-node.mjs',selectedProfile,ordinary,manifest.variants[trial.mode].artifacts.fpm.path,out,trial.label];
    const run={...trial,output:out,loadBefore:loadavg(),startedAt:new Date().toISOString(),...(hostProfiles?{hostProfile:selectedProfile}:{})};
    const result=spawnSync(process.execPath,args,{env:{...process.env,KANDELO_BENCH_WARMUP:'64',KANDELO_BENCH_ROUNDS:'7',KANDELO_BENCH_SEED:String(trial.seed)},encoding:'utf8',timeout:250000});
    Object.assign(run,{exit:result.status,signal:result.signal,loadAfter:loadavg(),finishedAt:new Date().toISOString()});
    if(result.error)run.error=String(result.error);
    writeFileSync(resolve(output,name+'.log'),(result.stdout??'')+(result.stderr??''));
    runs.push(run);writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
    if(result.status!==0)throw Error(`paired Node control failed: ${name}`);
    console.log(JSON.stringify(run));
  }
} else {
  const args=['node_modules/playwright/cli.js','test','--config','tools/common-memory-program/survey/paired.config.ts','--max-failures=1'];
  const result=spawnSync(process.execPath,args,{env:{...process.env,KANDELO_SURVEY_VARIANTS:variants,KANDELO_COMMON_MEMORY_PROFILE:profile,
    KANDELO_COMMON_MEMORY_NATIVE_FPM:native,KANDELO_COMMON_MEMORY_ARTIFACTS:output},encoding:'utf8',timeout:3600000});
  writeFileSync(resolve(output,'run.log'),(result.stdout??'')+(result.stderr??''));
  writeFileSync(resolve(output,'run.json'),JSON.stringify({args,exit:result.status,signal:result.signal,error:result.error?String(result.error):undefined},null,2)+'\n');
  if(result.status!==0)throw Error('paired browser controls failed');
}
verifyInputs(inputs);console.log('All paired controls passed with frozen inputs.');
