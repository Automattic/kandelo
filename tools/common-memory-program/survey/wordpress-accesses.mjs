// Dynamic translation counts only. The instrumented execution times are not
// latency evidence and must never enter the plain timing summarizer.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [profile,,,out]=process.argv.slice(2);
if(existsSync(out))throw Error('choose fresh access-count output');mkdirSync(out,{recursive:true});
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
if(typeof NodeKernelHost.prototype.commonMemoryPrototypeAccessCounts!=='function')throw Error('requires --access-diagnostics');
const original=NodeKernelHost.prototype.commonMemoryPrototypeStats,snapshots=[];
NodeKernelHost.prototype.commonMemoryPrototypeStats=async function(...args){const value=await original.apply(this,args);snapshots.push(await this.commonMemoryPrototypeAccessCounts());return value;};
const report={diagnostic:'access-counts',scope:'Per-root atomic diagnostic counters at original-function memory dispatch and generated wrapper/helper entry. Attempted operations, not completed accesses or CPU/latency. Background/tail work included. Snapshots are individually atomic counters, not one global transaction.',snapshots,passed:false};
try {await import('./wordpress-node.ts');}catch(error){report.error=String(error);process.exitCode=1;}finally{NodeKernelHost.prototype.commonMemoryPrototypeStats=original;}
try{
 const result=JSON.parse(readFileSync(resolve(out,'result.json'))),t=result.trial;
 result.diagnostic='access-counts';writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');
 if(!t?.passed||!result.destroyed||snapshots.length!==1+t.warmup+t.rounds)throw Error('incomplete application/count snapshots');
 const start=snapshots[t.warmup],end=snapshots.at(-1),previous=new Map(start.records.map(r=>[`${r.pid}:${r.root}`,new Map(r.values)]));
 if(end.version!==1||start.records.length!==end.records.length)throw Error('counter root inventory changed');
 report.delta=end.records.map(r=>{const p=previous.get(`${r.pid}:${r.root}`);if(!p)throw Error('counter worker/root identity changed');
  const values=r.values.map(([slot,value])=>{const delta=BigInt(value)-BigInt(p.get(slot)??0);if(delta<0n)throw Error('counter regression');return [slot,delta.toString()];}).filter(([,v])=>v!=='0');
  const category=values.filter(([slot])=>slot<256).reduce((n,[,v])=>n+BigInt(v),0n),functions=values.filter(([slot])=>slot>=256).reduce((n,[,v])=>n+BigInt(v),0n);
  if(category!==functions)throw Error(`dispatch/category accounting mismatch ${r.pid}: ${category}/${functions}`);
  return {pid:r.pid,root:r.root,total:category.toString(),values};});
 if(!report.delta.some(r=>BigInt(r.total)>0n))throw Error('empty dynamic counts');
 report.measuredPages=4*t.rounds;report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
writeFileSync(resolve(out,'access-counts.json'),JSON.stringify(report,null,2)+'\n');
