// Diagnostic profiles of the two real FPM execution workers. API start/stop
// boundaries calibrate each profile to the kernel owner's phase clock; do
// not compare V8 profile timestamps directly with Node monotonic timestamps.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [profile,,,out]=process.argv.slice(2);
if(existsSync(out))throw Error('choose a fresh worker profile output');
mkdirSync(out,{recursive:true});process.env.WASM_POSIX_PROFILE='1';
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
if(typeof NodeKernelHost.prototype.commonMemoryPrototypeWorkerProfile!=='function')throw Error('requires --worker-profile-diagnostics');
const original=NodeKernelHost.prototype.commonMemoryPrototypeStats;
const warmup=Number(process.env.KANDELO_SURVEY_WARMUP??4),rounds=Number(process.env.KANDELO_SURVEY_ROUNDS??7);
const report={scope:'Diagnostic FPM-worker sampling around a warm mixed-page workload, with background/tail cleanup included. Bookend status probes are outside the selected window. Samples are execution/wait states, not exact CPU-cycle attribution or uninstrumented latency.',profiles:[],passed:false};
let index=0,pids;
async function bounded(promise) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('worker profiling control timeout')),30000);})]);}
  finally {clearTimeout(timer);}
}
async function probe(host) {
  const responses=await Promise.all(Array.from({length:8},(_,i)=>host.fetchInKernel(8080,{method:'GET',url:`/common-memory-status.php?profile_probe=${i}`,headers:{Host:'localhost'},body:null},{timeoutMs:15000,maxResponseBytes:65536})));
  return [...new Set(responses.map(r=>{if(r.status!==200)throw Error('profiling wake probe failed');return JSON.parse(new TextDecoder().decode(r.body)).pid;}))].sort((a,b)=>a-b);
}
NodeKernelHost.prototype.commonMemoryPrototypeStats=async function(...args) {
  const value=await original.apply(this,args),phase=index++;
  if(phase===warmup) {
    pids=await probe(this);if(pids.length!==2)throw Error('profiling requires both actual FPM workers');report.pids=pids;
    const start=this.commonMemoryPrototypeWorkerProfile('start',pids);
    const [started,woken]=await bounded(Promise.all([start,probe(this)]));
    if(JSON.stringify(woken)!==JSON.stringify(pids))throw Error('FPM worker generation changed during profile start');
    report.started=started;report.begin=await this.commonMemoryPrototypeSyscallProfile();
  }
  if(phase===warmup+rounds) {
    report.end=await this.commonMemoryPrototypeSyscallProfile();
    const stop=this.commonMemoryPrototypeWorkerProfile('stop',pids);
    const [stopped,woken]=await bounded(Promise.all([stop,probe(this)]));
    if(JSON.stringify(woken)!==JSON.stringify(pids))throw Error('FPM worker generation changed during profile stop');
    report.stoppedOwnerClockNs=stopped.ownerClockNs;
    for(const record of stopped.profiles) {
      const data=typeof record.profile==='string'?JSON.parse(record.profile):record.profile;
      const file=`worker-${record.pid}.cpuprofile`;writeFileSync(resolve(out,file),JSON.stringify(data)+'\n');
      const us=ns=>Number(BigInt(ns))/1000;
      const low=Math.max(us(record.startBeforeNs)-data.startTime,us(record.stopBeforeNs)-data.endTime);
      const high=Math.min(us(record.startAfterNs)-data.startTime,us(record.stopAfterNs)-data.endTime);
      const begin=us(report.begin.clockNs)-low,end=us(report.end.clockNs)-high;
      if(!record.sameWorker||!Number.isFinite(low)||!Number.isFinite(high)||low>high||begin>=end)throw Error('invalid profile clock calibration/generation');
      let time=data.startTime;const selected=[];
      for(let i=0;i<data.samples.length;i++) {const previous=time,delta=data.timeDeltas[i];if(!Number.isFinite(delta)||delta<0)throw Error('invalid profile sample clock');time+=delta;if(previous>=begin&&time<=end)selected.push(i);}
      if(!selected.length)throw Error('no unambiguous samples in measured workload window');
      report.profiles.push({pid:record.pid,file,startBeforeNs:record.startBeforeNs,startAfterNs:record.startAfterNs,stopBeforeNs:record.stopBeforeNs,stopAfterNs:record.stopAfterNs,
        clockOffsetIntervalUs:[low,high],guaranteedWindowUs:[begin,end],selectedSampleIndices:selected,totalSamples:data.samples.length});
    }
  }
  return value;
};
try {await import('./wordpress-node.ts');}
catch(error){report.error=String(error);process.exitCode=1;}
finally {NodeKernelHost.prototype.commonMemoryPrototypeStats=original;}
try {
  const result=JSON.parse(readFileSync(resolve(out,'result.json')));
  if(!result.trial?.passed||!result.destroyed||report.profiles.length!==2)throw Error('incomplete application/worker profile');
  result.diagnostic='worker-cpu';writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
writeFileSync(resolve(out,'worker-profiles.json'),JSON.stringify(report,null,2)+'\n');
