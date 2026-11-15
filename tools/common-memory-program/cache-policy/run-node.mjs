// Descriptive app screen: two opposite orders; each child is a fresh parent.
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {loadavg} from 'node:os';
const [profile,kernel,output]=process.argv.slice(2).map(p=>resolve(p));mkdirSync(output);
const inputs=[...readdirSync('tools/common-memory-program/cache-policy').map(f=>resolve('tools/common-memory-program/cache-policy',f)),
 ...readdirSync(profile).filter(f=>f.endsWith('.mjs')||f.endsWith('.json')).map(f=>resolve(profile,f)),kernel];
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const frozen=Object.fromEntries(inputs.map(p=>[p,sha(p)]));
const report={scope:'Node application screen, two fresh parents per timing case; resource timing excluded; no browser performance or production acceptance claim',
 startedAt:new Date().toISOString(),loadBefore:loadavg(),frozen,trials:[],passed:false};
const save=()=>writeFileSync(resolve(output,'summary.json'),JSON.stringify(report,null,2)+'\n');
const inventory=spawnSync('scripts/agent-job',['list','--all'],{encoding:'utf8'});writeFileSync(resolve(output,'jobs-before.txt'),inventory.stdout+inventory.stderr);
try{
 for(const mode of ['timing','resource'])for(const backend of ['sqlite','mariadb']){
  const arms=[
   {name:'shared-empty-no-file',fixture:'.scratch/common-memory-impact-fixture-1',file:'off',arm:'vm-shared'},
   {name:'shared-empty-file',fixture:'.scratch/common-memory-impact-fixture-1',file:'on',arm:'vm-shared'},
   {name:'shared-seeded-file',fixture:'.scratch/opcache-wordpress-'+backend+'-seed-'+(backend==='sqlite'?'2':'1'),file:'on',arm:'vm-shared'},
   {name:'ordinary-seeded-file',fixture:'.scratch/opcache-ordinary-'+backend+'-seed-1',file:'on',arm:'native-file'},
  ];
  for(let order=0;order<(mode==='timing'?2:1);order++)for(const candidate of order?[...arms].reverse():arms){
   for(const [path,expected] of Object.entries(frozen))if(sha(path)!==expected)throw Error('input changed during screen: '+path);
   const id=[mode,backend,order,candidate.name].join('-'),destination=resolve(output,id);
   const trial={id,mode,backend,order,...candidate};report.trials.push(trial);save();console.log('Starting '+id);
   const child=spawnSync(process.execPath,['--experimental-wasm-exnref','--import','tsx/esm',
    'tools/common-memory-program/cache-policy/wordpress-probe.ts',candidate.fixture,profile,kernel,destination,backend,candidate.file,'0',candidate.arm,mode],
    {encoding:'utf8',timeout:330000,maxBuffer:8*1024*1024});
   writeFileSync(resolve(output,id+'.log'),(child.stdout??'')+(child.stderr??''));trial.exit=child.status;trial.signal=child.signal;
   if(child.error)trial.error=String(child.error);save();if(child.status!==0)throw Error('trial failed: '+id);
   const result=JSON.parse(readFileSync(resolve(destination,'result.json'),'utf8'));
   if(!result.passed||!result.destroyed||result.diagnostics.length)throw Error('trial incomplete: '+id);
   if(mode==='resource'&&(!result.os?.available||!result.os.complete))throw Error('incomplete OS footprint: '+id);
   console.log('Completed '+id+' firstHomepageMs='+result.trial.firstHomepageMs.toFixed(1));
  }
 }
 for(const [path,expected] of Object.entries(frozen))if(sha(path)!==expected)throw Error('input changed during screen: '+path);
 report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{report.loadAfter=loadavg();report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({passed:report.passed,trials:report.trials.length,error:report.error}));}
