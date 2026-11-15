// Node-only diagnostic wrapper. The ordinary WordPress entry point, frozen
// host files and guest responses are unchanged. Never pool this with plain
// timings: process CPU includes background work on all this process's threads.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [profile,,,out]=process.argv.slice(2);
if(existsSync(out))throw Error('choose a fresh CPU diagnostic output');
mkdirSync(out,{recursive:true});
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const original=NodeKernelHost.prototype.fetchInKernel;
if(typeof original!=='function')throw Error('missing ordinary host fetch method');
const records=[],active=new Set(),clockProbe=[];
for(let round=0;round<4;round++) {
  const cpu=process.cpuUsage(),wall=performance.now();
  for(let i=0;i<1000;i++){process.cpuUsage();performance.now();}
  clockProbe.push({calls:1000,elapsedMs:performance.now()-wall,...process.cpuUsage(cpu)});
}
NodeKernelHost.prototype.fetchInKernel=async function(...args) {
  const row={sequence:records.length,url:args[1]?.url,overlapped:active.size!==0};
  for(const other of active)other.overlapped=true;
  records.push(row);active.add(row);
  const cpu=process.cpuUsage(),started=performance.now();
  try {
    const response=await original.apply(this,args);
    row.status=response.status;row.bytes=response.body.length;return response;
  } catch(error) {row.error=String(error);throw error;}
  finally {
    row.elapsedMs=performance.now()-started;row.cpu=process.cpuUsage(cpu);active.delete(row);
  }
};
let error;
try {await import('./wordpress-node.ts');}
catch(cause){error=String(cause);process.exitCode=1;}
finally {NodeKernelHost.prototype.fetchInKernel=original;}
const report={scope:'Instrumented Node fetchInKernel interval; process user/system CPU in microseconds includes all runtime threads and background work, excluding other OS processes. Not per-function CPU, browser CPU, or uninstrumented latency. Overlapping intervals are not additive.',
  api:'https://nodejs.org/download/release/v24.15.0/docs/api/process.html#processcpuusagepreviousvalue',
  runtime:process.version,clockProbe,records,samples:[],error};
try {
  const result=JSON.parse(readFileSync(resolve(out,'result.json'))),trial=result.trial;
  if(!trial?.passed||!result.destroyed)throw Error('ordinary application/teardown failed');
  const status=records.findIndex(r=>r.url?.startsWith('/common-memory-status.php?'));
  if(status<0)throw Error('missing post-workload status boundary');
  const selected=records.slice(0,status).slice(-trial.samples.length);
  if(selected.length!==trial.samples.length)throw Error('missing CPU request intervals');
  const paths={home:'/',article:'/?p=1',admin:'/wp-admin/',posts:'/?rest_route=/wp/v2/posts&per_page=1'};
  for(let i=0;i<selected.length;i++) {
    const row=selected[i],sample=trial.samples[i];
    if(row.url!==paths[sample.workload]||row.bytes!==sample.bytes||row.status!==200||row.error||row.overlapped||
      !Number.isFinite(row.cpu?.user)||!Number.isFinite(row.cpu?.system)||row.cpu.user<0||row.cpu.system<0||row.cpu.user+row.cpu.system<=0)
      throw Error('ambiguous, overlapping or invalid measured CPU interval');
    report.samples.push({...sample,fetchSequence:row.sequence,fetchWallMs:row.elapsedMs,cpuUserUs:row.cpu.user,cpuSystemUs:row.cpu.system});
  }
  report.passed=true;
} catch(cause) {report.error=String(cause);process.exitCode=1;}
if(existsSync(out))writeFileSync(resolve(out,'cpu-records.json'),JSON.stringify(report,null,2)+'\n');
else throw Error(report.error??'missing diagnostic output');
