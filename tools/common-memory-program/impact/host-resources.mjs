import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const exec=promisify(execFile);
export async function processTree(rootPid) {
  const {stdout}=await exec('/bin/ps',['-axo','pid=,ppid=,rss=,comm=']);
  const all=stdout.split('\n').map(line=>/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
    .map(m=>({pid:Number(m[1]),ppid:Number(m[2]),rssBytes:Number(m[3])*1024,command:m[4]}));
  const pids=new Set([rootPid]);let changed=true;
  while(changed){changed=false;for(const row of all)if(pids.has(row.ppid)&&!pids.has(row.pid)){pids.add(row.pid);changed=true;}}
  return all.filter(row=>pids.has(row.pid));
}
export async function physicalFootprint(rootPid,output,name,{tree=false}={}) {
  if(process.platform!=='darwin')return{available:false,reason:'macOS physical-footprint tool unavailable'};
  const rows=tree?await processTree(rootPid):[{pid:rootPid}];
  if(!rows.some(row=>row.pid===rootPid))throw Error('owned root process missing before footprint');
  await mkdir(output,{recursive:true});
  const path=resolve(output,name+'.footprint.json');
  const startedAt=new Date().toISOString(),started=performance.now();
  const run=await exec('/usr/bin/footprint',['--noCategories','-f','bytes','-j',path,...rows.map(row=>String(row.pid))],{timeout:20000,maxBuffer:4*1024*1024});
  await writeFile(resolve(output,name+'.footprint.txt'),run.stdout+run.stderr);
  const raw=JSON.parse(await readFile(path,'utf8'));
  if(raw['bytes per unit']!==1||!Number.isFinite(raw['total footprint']))throw Error('unknown physical-footprint units');
  const reported=new Set(raw.processes.map(p=>p.pid)),missingPids=rows.filter(p=>!reported.has(p.pid)).map(p=>p.pid);
  return{available:true,complete:missingPids.length===0&&Object.keys(raw.errors??{}).length===0,missingPids,startedAt,elapsedMs:performance.now()-started,scope:tree?'owned launch process and ps-visible descendants':'one Node OS process including its Worker threads',
    totalFootprintBytes:raw['total footprint'],processes:raw.processes.map(p=>({pid:p.pid,name:p.name,footprintBytes:p.footprint})),
    errors:raw.errors,warnings:raw.warnings,shared:raw.shared,ps:rows,raw:path};
}
export function timerResolution() {
  let last=performance.now(),minimum=Infinity;
  for(let i=0;i<100000;i++){const next=performance.now();if(next>last)minimum=Math.min(minimum,next-last);last=next;}
  return Number.isFinite(minimum)?minimum:null;
}
