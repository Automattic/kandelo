import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {ltoForkPlan} from './lto-fork-plan.mjs';
const [fixture,profile,output]=process.argv.slice(2).map(p=>resolve(p));
if(existsSync(output))throw Error('fresh output required');
mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(fixture,'manifest.json'))),runs=[];
for(const control of ltoForkPlan(manifest)) {
 const artifact=manifest.variants[control.mode][control.addressing];
 if(createHash('sha256').update(readFileSync(artifact.path)).digest('hex')!==artifact.sha256)throw Error('fixture changed');
 const out=resolve(output,control.id),args=['tools/common-memory-program/survey/lto-fork-node.mjs',profile,artifact.path,out,JSON.stringify(control)];
 const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:90000});
 writeFileSync(resolve(output,control.id+'.log'),(run.stdout??'')+(run.stderr??''));
 runs.push({control,args,exit:run.status,signal:run.signal,error:run.error?String(run.error):undefined});
 writeFileSync(resolve(output,'runs.json'),JSON.stringify(runs,null,2)+'\n');
 if(run.status!==0)throw Error('LTO real fork control failed: '+control.id);
 const result=JSON.parse(readFileSync(resolve(out,'result.json')));
 if(result.artifactSha256!==artifact.sha256)throw Error('child fixture identity changed');
 console.log(control.id+' passed');
}
