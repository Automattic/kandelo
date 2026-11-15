// Includes detached WebKit XPC services in resource runs. The original
// run.mjs remains the frozen tree-only runner for the first campaign.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {loadavg} from 'node:os';
import {createHash} from 'node:crypto';
const [path]=process.argv.slice(2),plan=JSON.parse(readFileSync(path,'utf8'));
function verifyInputs(){for(const [file,digest] of Object.entries(plan.inputs??{}))if(createHash('sha256').update(readFileSync(file)).digest('hex')!==digest)throw Error('frozen input changed: '+file);}
verifyInputs();
if(existsSync(plan.output))throw Error('use fresh output');mkdirSync(plan.output,{recursive:true});
const runs=[];writeFileSync(resolve(plan.output,'plan.json'),JSON.stringify(plan,null,2)+'\n');
for(const trial of plan.trials){
 verifyInputs();
 if(!/^[a-z0-9-]+$/.test(trial.id))throw Error('invalid trial ID');
 const before=loadavg(),start=new Date().toISOString();let args;
 if(trial.host==='node')args=['--experimental-wasm-exnref','--import','tsx/esm','tools/common-memory-program/impact/node.ts',plan.fixture,plan.profile,plan.kernel,resolve(plan.output,trial.id),trial.label,trial.backend,trial.mode,String(trial.cohort)];
 else args=['apps/browser-demos/node_modules/playwright/cli.js','test','--config',trial.host==='webkit'&&trial.mode==='resource'?'tools/common-memory-program/impact/playwright-xpc.config.ts':'tools/common-memory-program/impact/playwright.config.ts','--project='+trial.host,'--grep',trial.id+'$','--max-failures=1'];
 const r=spawnSync(process.execPath,args,{env:{...process.env,KANDELO_IMPACT_PLAN:resolve(path),KANDELO_COMMON_MEMORY_ARTIFACTS:resolve(plan.output)},encoding:'utf8',timeout:420000,maxBuffer:8*1024*1024});
 writeFileSync(resolve(plan.output,trial.id+'.log'),(r.stdout??'')+(r.stderr??''));
 runs.push({...trial,args,exit:r.status,signal:r.signal,error:r.error?String(r.error):undefined,start,finish:new Date().toISOString(),loadBefore:before,loadAfter:loadavg()});
 writeFileSync(resolve(plan.output,'runs.json'),JSON.stringify(runs,null,2)+'\n');console.log(trial.id,r.status);
 if(r.status!==0)throw Error('impact trial failed: '+trial.id);
}
verifyInputs();
