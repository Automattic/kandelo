// WebKit's cached test build launches XPC services with PPID 1. Identify
// new services from that exact build only, under exclusive launch ownership.
// This is a measurement coverage correction, not a runtime workaround.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
const exec=promisify(execFile);
async function inventory() {
  const {stdout}=await exec('/bin/ps',['-axo','pid=,ppid=,rss=,comm=']);
  return stdout.split('\n').map(line=>/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
    .map(m=>({pid:Number(m[1]),ppid:Number(m[2]),rssBytes:Number(m[3])*1024,command:m[4]}));
}
export async function beforeWebKitLaunch(executable) {
  const buildRoot=dirname(resolve(executable));
  if(!buildRoot.includes('/ms-playwright/webkit-'))throw Error('unrecognized WebKit build root');
  const rows=await inventory(),existing=rows.filter(row=>row.command.startsWith(buildRoot+'/'));
  if(existing.length)throw Error('WebKit test build already in use; cannot attribute detached XPC services');
  return{buildRoot,baselinePids:rows.map(row=>row.pid),capturedAt:new Date().toISOString()};
}
export async function webkitPhysicalFootprint(rootPid,output,name,ownership) {
  if(process.platform!=='darwin')throw Error('WebKit XPC resource probe requires macOS');
  const all=await inventory(),before=new Set(ownership.baselinePids);
  const pids=new Set([rootPid]);let changed=true;
  while(changed){changed=false;for(const row of all)if(pids.has(row.ppid)&&!pids.has(row.pid)){pids.add(row.pid);changed=true;}}
  const related=all.filter(row=>row.command.startsWith(ownership.buildRoot+'/'));
  const launchers=related.filter(row=>row.command.endsWith('/Playwright.app/Contents/MacOS/Playwright'));
  if(launchers.length!==1||!pids.has(launchers[0].pid))throw Error('WebKit launch ownership is ambiguous');
  const xpc=related.filter(row=>/\/com\.apple\.WebKit\.(?:Networking|GPU|WebContent)\.xpc\/Contents\/MacOS\/com\.apple\.WebKit\.(?:Networking|GPU|WebContent)\.Development$/.test(row.command));
  if(xpc.some(row=>before.has(row.pid)))throw Error('pre-existing WebKit XPC process');
  for(const row of xpc)pids.add(row.pid);
  if(!xpc.some(row=>row.command.includes('WebContent.xpc/')))throw Error('missing WebKit WebContent process');
  const rows=all.filter(row=>pids.has(row.pid));
  if(!rows.some(row=>row.pid===rootPid))throw Error('WebKit launch root disappeared');
  const unknown=related.filter(row=>!pids.has(row.pid));
  if(unknown.length)throw Error('unattributed process from selected WebKit build');
  await mkdir(output,{recursive:true});const path=resolve(output,name+'.footprint.json');
  const startedAt=new Date().toISOString(),started=performance.now();
  const run=await exec('/usr/bin/footprint',['--noCategories','-f','bytes','-j',path,...rows.map(row=>String(row.pid))],{timeout:20000,maxBuffer:4*1024*1024});
  await writeFile(resolve(output,name+'.footprint.txt'),run.stdout+run.stderr);
  const raw=JSON.parse(await readFile(path,'utf8'));
  if(raw['bytes per unit']!==1||!Number.isFinite(raw['total footprint']))throw Error('unknown physical-footprint units');
  const reported=new Set(raw.processes.map(p=>p.pid)),missingPids=rows.filter(p=>!reported.has(p.pid)).map(p=>p.pid);
  return{available:true,complete:missingPids.length===0&&Object.keys(raw.errors??{}).length===0,missingPids,startedAt,elapsedMs:performance.now()-started,
    scope:'owned WebKit launch tree plus newly launched XPC services from its exclusive cached test build',
    ownership,detachedXpc:xpc,totalFootprintBytes:raw['total footprint'],
    processes:raw.processes.map(p=>({pid:p.pid,name:p.name,footprintBytes:p.footprint})),errors:raw.errors,warnings:raw.warnings,shared:raw.shared,ps:rows,raw:path};
}
