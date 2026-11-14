// Run complete matched cohorts sequentially; builds and timing jobs must
// not overlap. A failed stage stops the collection and retains all evidence.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
const [variants,profile,image,native,output]=process.argv.slice(2).map(p=>resolve(p));
if(existsSync(output))throw Error('choose a fresh output directory');mkdirSync(output,{recursive:true});
const env={...process.env,KANDELO_SURVEY_MODES:'baseline,fuse-small',KANDELO_SURVEY_WARMUP:'4',KANDELO_SURVEY_ROUNDS:'7'};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const stages=['node','browser'].flatMap(host=>['sqlite','mariadb'].map(backend=>({host,backend}))),runs=[];
for(const stage of stages) {
  const name=`${stage.host}-${stage.backend}`,out=resolve(output,name);
  const args=[`tools/common-memory-program/survey/wordpress-run-${stage.host==='node'?'node':'browsers'}.mjs`,variants,profile,image,native,out,stage.backend];
  const row={...stage,output:out,args,startedAt:new Date().toISOString()};
  console.log(`Starting ${name}: adjacent same-cache controls,4 warmup rounds,7 measured rounds.`);
  const result=spawnSync(process.execPath,args,{env,stdio:'inherit'});
  Object.assign(row,{exit:result.status,signal:result.signal,finishedAt:new Date().toISOString()});
  if(result.error)row.error=String(result.error);
  runs.push(row);writeFileSync(resolve(output,'stages.json'),JSON.stringify(runs,null,2)+'\n');
  if(result.status!==0)throw Error(`replication stage failed: ${name}`);
  const summary=spawnSync('python3',['tools/common-memory-program/survey/summarize-wordpress.py',out,resolve(output,name+'-summary.json')],{env,stdio:'inherit'});
  if(summary.status!==0)throw Error(`replication summary failed: ${name}`);
  console.log(`Completed ${name}; all controls and identities validated.`);
}
const reference=JSON.parse(readFileSync(resolve(runs[0].output,'inputs.json'))),report={schema:1,scope:'WordPress small-offset fusion replication; all four hosts and both backends',hosts:{},trials:0,samples:0};
for(const stage of runs) {
  const input=JSON.parse(readFileSync(resolve(stage.output,'inputs.json')));
  for(const key of ['inputs','plan','identities'])if(JSON.stringify(canonical(input[key]))!==JSON.stringify(canonical(reference[key])))throw Error(`frozen ${key} differs across stages`);
  const data=JSON.parse(readFileSync(resolve(output,`${stage.host}-${stage.backend}-summary.json`)));
  for(const [host,result] of Object.entries(data.hosts)) {
    report.hosts[host]??={};report.hosts[host][stage.backend]=result;
  }
  report.trials+=data.trials;report.samples+=data.samples;
}
if(report.trials!==96||report.samples!==4224||Object.keys(report.hosts).length!==4||Object.values(report.hosts).some(backends=>Object.keys(backends).length!==2))
  throw Error('replication inventory mismatch');
writeFileSync(resolve(output,'summary.json'),JSON.stringify(report,null,2)+'\n');
console.log('Complete replication:96 controls,4,224 page samples,all hosts/backends with matching frozen inputs.');
