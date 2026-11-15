// Read-only snapshots of the existing kernel syscall profiler in a private
// diagnostic profile. Handler wall times are not process CPU measurements.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [profile,,,out]=process.argv.slice(2);
if(existsSync(out))throw Error('choose a fresh syscall diagnostic output');
mkdirSync(out,{recursive:true});
process.env.WASM_POSIX_PROFILE='1';
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
if(typeof NodeKernelHost.prototype.commonMemoryPrototypeSyscallProfile!=='function')throw Error('requires --syscall-diagnostics host profile');
const original=NodeKernelHost.prototype.commonMemoryPrototypeStats,snapshots=[];
NodeKernelHost.prototype.commonMemoryPrototypeStats=async function(...args) {
  const value=await original.apply(this,args);
  snapshots.push(await this.commonMemoryPrototypeSyscallProfile());return value;
};
const report={scope:'Kernel-profiler dispatch counts and handler wall time for all guest processes between normal resource snapshots; includes background/tail cleanup, not per-PHP-function CPU or uninstrumented latency.',snapshots,passed:false};
try {await import('./wordpress-node.ts');}
catch(error){report.error=String(error);process.exitCode=1;}
finally {NodeKernelHost.prototype.commonMemoryPrototypeStats=original;}
try {
  const result=JSON.parse(readFileSync(resolve(out,'result.json'))),t=result.trial;
  if(!t?.passed||!result.destroyed||snapshots.length!==1+t.warmup+t.rounds||!snapshots.every(s=>s.entries.length))throw Error('incomplete application/profiler snapshots');
  const begin=snapshots[t.warmup],end=snapshots.at(-1),previous=new Map(begin.entries.map(e=>[e.nr,e]));
  const {ABI_SYSCALL_NAMES}=await import('../../../host/src/generated/abi.ts');
  report.beginClockNs=begin.clockNs;report.endClockNs=end.clockNs;report.measuredPages=4*t.rounds;
  report.delta=end.entries.map(e=>{const p=previous.get(e.nr)??{count:0,totalTimeMs:0,retries:0};return {nr:e.nr,names:ABI_SYSCALL_NAMES[e.nr]?[ABI_SYSCALL_NAMES[e.nr]]:[],count:e.count-p.count,handlerWallMs:e.totalTimeMs-p.totalTimeMs,retries:e.retries-p.retries};}).filter(e=>e.count||e.retries);
  if(!report.delta.length||report.delta.some(e=>e.count<0||e.retries<0||e.handlerWallMs<0))throw Error('invalid nonmonotonic profile delta');
  report.passed=true;
} catch(error){report.error=String(error);process.exitCode=1;}
writeFileSync(resolve(out,'syscall-records.json'),JSON.stringify(report,null,2)+'\n');
