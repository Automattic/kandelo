// Serialize Node/browser paired timings and validate the complete inventory.
// Run only after correctness checks and other owned CPU jobs have completed.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pairedPlan} from './paired-plan.mjs';
const [variants,profile,native,output]=process.argv.slice(2).map(p=>resolve(p));
if(existsSync(output))throw Error('choose a fresh output directory');
mkdirSync(output,{recursive:true});
const manifest=JSON.parse(readFileSync(resolve(variants,'manifest.json'))),plan=pairedPlan(manifest),stages=[];
for(const host of ['node','browser']) {
  const out=resolve(output,host),args=['tools/common-memory-program/survey/paired-run.mjs',host,variants,profile,native,out];
  const row={host,args,startedAt:new Date().toISOString()};
  console.log(`Starting ${host}: ${plan.length} adjacent controls,64 warmup rounds,7 measured rounds.`);
  const run=spawnSync(process.execPath,args,{stdio:'inherit'});
  Object.assign(row,{exit:run.status,signal:run.signal,finishedAt:new Date().toISOString()});
  if(run.error)row.error=String(run.error);
  stages.push(row);writeFileSync(resolve(output,'stages.json'),JSON.stringify(stages,null,2)+'\n');
  if(run.status!==0)throw Error(`${host} paired matrix failed; partial evidence retained`);
}
const args=['tools/common-memory-program/survey/summarize-paired.py',resolve(output,'node'),resolve(output,'browser'),resolve(output,'summary.json')];
const summary=spawnSync('python3',args,{stdio:'inherit'});
if(summary.status!==0)throw Error('paired summary validation failed');
const report=JSON.parse(readFileSync(resolve(output,'summary.json')));
if(report.controls!==plan.length*4||report.samples!==plan.length*4*436)
  throw Error('complete matrix count mismatch');
console.log(`Completed ${report.controls} parents and ${report.samples} request samples with matching frozen Node/browser inputs.`);
