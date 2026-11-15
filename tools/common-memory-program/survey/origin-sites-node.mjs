// Separate from latency collection: overlapping diagnostic classes are not
// part of the ordinary category total and must never be timed as a candidate.
import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [profile,,,out]=process.argv.slice(2);
if(existsSync(out))throw Error('choose fresh origin-count output');mkdirSync(out,{recursive:true});
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const original=NodeKernelHost.prototype.commonMemoryPrototypeStats,snapshots=[];
if(typeof NodeKernelHost.prototype.commonMemoryPrototypeAccessCounts!=='function')throw Error('requires diagnostic host');
NodeKernelHost.prototype.commonMemoryPrototypeStats=async function(...args){const value=await original.apply(this,args);snapshots.push(await this.commonMemoryPrototypeAccessCounts());return value;};
const report={diagnostic:'origin-sites',scope:'Overlapping shape-candidate attempts. Four mixed-page requests after two warmup rounds; individually atomic snapshots. Not eligibility, CPU or latency.',snapshots,passed:false};
try{await import('./wordpress-node.ts');}catch(error){report.error=String(error);process.exitCode=1;}
finally{NodeKernelHost.prototype.commonMemoryPrototypeStats=original;}
try{
 const result=JSON.parse(readFileSync(resolve(out,'result.json'))),t=result.trial;
 result.diagnostic='origin-sites';writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');
 if(!t?.passed||!result.destroyed||result.stderr.length||result.diagnostics.length||snapshots.length!==4||t.rounds!==1||t.warmup!==2)throw Error('incomplete application/count snapshots');
 const start=snapshots[2],end=snapshots[3],previous=new Map(start.records.map(r=>[`${r.pid}:${r.root}`,new Map(r.values)]));
 if(end.version!==1||start.records.length!==end.records.length)throw Error('counter inventory changed');
 report.delta=end.records.map(r=>{
  const p=previous.get(`${r.pid}:${r.root}`);if(!p)throw Error('root identity changed');
  const values=r.values.map(([slot,value])=>{const delta=BigInt(value)-BigInt(p.get(slot)??0);if(delta<0n)throw Error('counter regression');return [slot,delta.toString()];}).filter(([,v])=>v!=='0');
  const category=values.filter(([s])=>s<192).reduce((n,[,v])=>n+BigInt(v),0n),functions=values.filter(([s])=>s>=256).reduce((n,[,v])=>n+BigInt(v),0n);
  if(category!==functions||values.some(([s])=>s>=192&&s<256&&(s<208||s>214)))throw Error('category/function accounting mismatch');
  return{pid:r.pid,root:r.root,total:category.toString(),values};
 });
 if(!report.delta.some(r=>BigInt(r.total)>0n))throw Error('empty diagnostic');
 report.measuredPages=4;report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
writeFileSync(resolve(out,'origin-sites.json'),JSON.stringify(report,null,2)+'\n');
