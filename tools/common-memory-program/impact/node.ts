import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadavg} from 'node:os';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {wordpressTrial} from '../survey/wordpress-fixture.mjs';
import {physicalFootprint,timerResolution} from './host-resources.mjs';
import {fileCacheInventory} from './shared.mjs';
const [fixture,profile,kernel,output,label,backend,mode='timing',cohort='0']=process.argv.slice(2);
if(!['native-file','vm-file','vm-shared'].includes(label)||!['timing','resource','check'].includes(mode))throw Error('invalid impact arm/mode');
mkdirSync(output);const manifest=JSON.parse(readFileSync(resolve(fixture,'manifest.json'),'utf8'));
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const artifact=resolve(fixture,manifest.arms[label]);
const result:any={host:'node',version:process.version,execArgv:process.execArgv,label,backend,mode,cohort:Number(cohort),
  loadBefore:loadavg(),startedAt:new Date().toISOString(),timerResolutionMs:timerResolution(),
  identities:{image:sha(manifest.image),artifact:sha(artifact),kernel:sha(kernel),profile:sha(resolve(profile,'common-memory-profile.json'))},
  stdout:[],stderr:[],diagnostics:[],resources:[]};
const save=()=>writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const host=new NodeKernelHost({rootfsImage:readFileSync(manifest.image),maxWorkers:24,
  onStdout:(pid:number,b:Uint8Array)=>result.stdout.push({pid,text:new TextDecoder().decode(b)}),
  onStderr:(pid:number,b:Uint8Array)=>result.stderr.push({pid,text:new TextDecoder().decode(b)}),
  onHostDiagnostic:(e:unknown)=>result.diagnostics.push(e)});
const resource=async(phase:string)=>{
  const sample:any={phase,timeMs:performance.now(),nodeMemory:process.memoryUsage(),cpu:process.cpuUsage(),usage:process.resourceUsage()};
  if(mode==='resource')sample.os=await physicalFootprint(process.pid,output,'resource-'+result.resources.length);
  result.resources.push(sample);return sample;
};
const oldStats=host.commonMemoryPrototypeStats.bind(host);
if(mode!=='timing')host.commonMemoryPrototypeStats=async()=>{
  const stats=await oldStats();
  const inspection=await host.inspectProcesses(),kernelLinearBytes=(await host.getKernelMemoryPages())*65536;
  const sample=await resource('round-'+result.resources.filter((r:any)=>r.phase.startsWith('round-')).length);
  Object.assign(sample,{inspection,kernelLinearBytes});return stats;
};
const watchdog=setTimeout(()=>{result.timeout=true;save();void host.destroy();},300000);
try {
  await resource('before-init');
  await host.init(Uint8Array.from(readFileSync(kernel)).buffer);
  await resource('after-init');
  const before=process.cpuUsage();
  result.trial=await wordpressTrial(host,Uint8Array.from(readFileSync(artifact)).buffer,{
    label,backend,wpConfig:renderWordPressConfig('selectable','/','http'),seed:6197+Number(cohort),
    validateTimestamps:true,checkTimestampPolicy:mode==='check',warmup:mode==='check'?0:4,rounds:mode==='check'?1:mode==='resource'?3:7,
    persist:(trial:unknown)=>{result.trial=trial;save();}});
  result.workloadCpu=process.cpuUsage(before);
  if(!result.trial.passed)throw Error(result.trial.error??'trial failed');
  const ini=result.trial.phpIni;
  if(!/^opcache.validate_timestamps=1$/m.test(ini)||!/^opcache.revalidate_freq=0$/m.test(ini))throw Error('timestamp configuration drift');
  if(mode!=='timing'){
    const rows=result.resources.filter((r:any)=>r.inspection);
    for(let i=0;i<rows.length;i++)rows[i].phase=result.trial.memory[i].phase;
    const report=rows.at(-1).inspection;
    const fpm=report.processes.filter((p:any)=>p.cmdline.includes('/usr/sbin/php-fpm'));
    if(fpm.length!==3)throw Error('wrong FPM master/worker count');
    result.fpm=fpm; result.memoryGroups=report.memoryGroups;
    result.fileCache=await fileCacheInventory(host);
    if(label==='vm-shared'?result.fileCache.files!==0:result.fileCache.files<100)throw Error('unexpected OPcache FILE corpus');
  }
  await resource('before-destroy');
  result.passed=true;
}catch(error){result.error=String(error);}
finally{
  try{await host.destroy();result.destroyed=true;}catch(error){result.destroyError=String(error);}
  clearTimeout(watchdog);await resource('after-destroy');result.loadAfter=loadavg();save();
}
if(!result.passed||!result.destroyed||result.diagnostics.length){console.error(result.error??result.diagnostics);process.exitCode=1;}
else console.log(JSON.stringify({passed:true,label,backend,mode,samples:result.trial.samples.length}));
