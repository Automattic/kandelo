import{spawnSync}from'node:child_process';
import{readFileSync,writeFileSync,mkdirSync,existsSync}from'node:fs';
import{resolve}from'node:path';
import{createHash}from'node:crypto';
import{loadavg}from'node:os';
import{wordpressPairedInputs,wordpressPairedEnvironment,readWordpressPairedInputs}from'./wordpress-paired-inputs.mjs';
import{verifyInputs}from'./paired-inputs.mjs';
import{wordpressResourcePlan}from'./wordpress-resource-plan.mjs';

const[host,...args]=process.argv.slice(2),[variants,profile,image,native,output]=args.slice(0,5).map(p=>resolve(p));
if(!['node','browser'].includes(host)||args.length!==5)throw Error('resource study requires host/variants/profile/image/native/output');
if(existsSync(output))throw Error('choose fresh resource output');
const manifest=readWordpressPairedInputs(variants),plan=wordpressResourcePlan(manifest);
for(const mode of ['ordinary','control','reuse']) {
  const settings=JSON.parse(readFileSync(resolve(manifest.hostProfiles[mode],'profile-inputs.json')));
  if(settings.scratchBytes!==1048576||settings.forkBacking!=='unique-private-pages-v1'||settings.groupInitialPages!=='maximumPages')
    throw Error('resource profile changed sparse/scratch/pregrown settings');
  if((mode==='reuse')!==(settings.unmappedReuse==='tracked-roots-snapshot-pins-v1'))throw Error('wrong reuse profile mode');
  if(Object.keys(settings).some(k=>/byte.?slice/i.test(k)&&settings[k]))throw Error('byte-slice/reuse lifetime combination is not admitted');
}
const frozen=wordpressPairedInputs(variants,profile,image,native,manifest,{backend:'sqlite',...manifest.resourceSettings});
frozen.plan=plan;frozen.scope='RT01 fixed-pool SQLite WordPress allocation study. Existing sparse/1MiB scratch profiles, 128 four-page rounds after two warmups; same guests, ceilings and watchdogs. Fresh parent/case/host, ordinary FILE reference and two VM/shared controls. Actual failed application statuses and partial progress retained; no latency ranking, RSS or process-retirement claim.';
for(const p of manifest.provenanceFiles??[])frozen.inputs[resolve(p)]=createHash('sha256').update(readFileSync(p)).digest('hex');
mkdirSync(output);writeFileSync(resolve(output,'inputs.json'),JSON.stringify(frozen,null,2)+'\n');
const runs=[];
if(host==='node') {
  for(const trial of plan) {
    const name=`node-${trial.cohort}-${trial.block}-${trial.order}-${trial.mode}-${trial.label}`,out=resolve(output,name);
    const artifact=trial.label==='native-file'?manifest.nativeArtifacts[trial.mode].path:manifest.variants[trial.mode].artifacts.fpm.path;
    const argv=['--import','tsx/esm','tools/common-memory-program/survey/wordpress-node.ts',frozen.hostProfiles[trial.mode],image,artifact,out,trial.label,'sqlite'];
    const row={...trial,argv,startedAt:new Date().toISOString(),loadBefore:loadavg()};
    const r=spawnSync(process.execPath,argv,{env:{...process.env,...wordpressPairedEnvironment(frozen,trial.mode),KANDELO_SURVEY_SEED:String(trial.seed)},encoding:'utf8',timeout:320000});
    Object.assign(row,{exit:r.status,signal:r.signal,finishedAt:new Date().toISOString(),loadAfter:loadavg(),error:r.error?String(r.error):undefined});
    writeFileSync(resolve(output,name+'.log'),(r.stdout??'')+(r.stderr??''));runs.push(row);writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');console.log(JSON.stringify(row));
    // Preserve failure as failure, then collect the other independent case.
    // A resource boundary must not prevent obtaining the comparison's curve.
  }
}else {
  const argv=['node_modules/playwright/cli.js','test','--config','tools/common-memory-program/survey/wordpress-paired.config.ts','--max-failures=0','--retries=0'];
  const r=spawnSync(process.execPath,argv,{env:{...process.env,KANDELO_SURVEY_VARIANTS:variants,KANDELO_SURVEY_PAIRED_INPUTS:resolve(output,'inputs.json'),KANDELO_SURVEY_IMAGE:image,KANDELO_COMMON_MEMORY_ARTIFACTS:output},encoding:'utf8',timeout:3600000});
  writeFileSync(resolve(output,'run.log'),(r.stdout??'')+(r.stderr??''));runs.push({argv,exit:r.status,signal:r.signal,error:r.error?String(r.error):undefined});writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
}
verifyInputs(frozen.inputs);
const expected=(host==='node'?['node']:['chromium','firefox','webkit']).flatMap(engine=>plan.map(t=>
  host==='node'?resolve(output,`${engine}-${t.cohort}-${t.block}-${t.order}-${t.mode}-${t.label}`,'result.json'):
    resolve(output,`${engine}-${t.cohort}-${t.block}-${t.order}-${t.mode}-${t.label}.json`)));
const missing=expected.filter(p=>!existsSync(p));
const malformed=[],observations=[];
for(const path of expected.filter(p=>existsSync(p))) {
  try {
    const data=JSON.parse(readFileSync(path));const run=host==='node'?data:data.run??data.progress;
    observations.push({path,applicationPassed:run?.trial?.passed===true&&run?.destroyed===true&&
      !run?.stderr?.length&&!run?.diagnostics?.length&&!data.error&&!data.events?.length,
      recordedPages:run?.trial?.samples?.length??0,trialError:run?.trial?.error,outerError:data.error});
  }catch(error){malformed.push({path,error:String(error)});}
}
const receipt={collectionComplete:missing.length===0&&malformed.length===0,expectedResults:expected.length,missing,malformed,observations,commands:runs.map(r=>({exit:r.exit,signal:r.signal,error:r.error})),frozenInputsStable:Object.keys(frozen.inputs).length,scope:'Collection receipt only. Command/test failures retain nonzero statuses and are NOT application passes; inspect every raw result/progress/error.'};
writeFileSync(resolve(output,'collection-receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
if(missing.length||malformed.length)throw Error('resource collection incomplete; preserve partial results');
