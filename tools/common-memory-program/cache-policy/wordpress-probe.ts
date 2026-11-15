// One trial per Node parent. Diagnostic logging is deliberately kept out of
// timing comparisons; it proves that a seed was deserialized into shared RAM.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {loadavg} from 'node:os';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {wordpressTrial} from './wordpress-fixture.mjs';
import {physicalFootprint,timerResolution} from '../impact/host-resources.mjs';
import {fileCacheInventory} from '../impact/shared.mjs';
const [fixture,profile,kernel,output,backend='sqlite',fileCache='on',diagnostic='0',arm='vm-shared',mode='timing']=process.argv.slice(2);
if(!['on','off'].includes(fileCache)||!['0','1'].includes(diagnostic))throw Error('invalid cache/probe options');
if(!['vm-shared','native-file'].includes(arm)||arm==='native-file'&&fileCache!=='on')throw Error('invalid arm');
mkdirSync(output);const manifest=JSON.parse(readFileSync(resolve(fixture,'manifest.json'),'utf8'));
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const binary=readFileSync(resolve(fixture,arm==='native-file'?'ordinary-fpm.wasm':'translated-fpm.wasm')),image=readFileSync(manifest.image);
if(sha(binary)!==(arm==='native-file'?manifest.ordinaryFpmSha256:manifest.translatedFpmSha256)||sha(image)!==manifest.imageSha256)throw Error('fixture identity mismatch');
const report:any={backend,arm,fileCache,diagnostic:diagnostic==='1',passed:false,diagnostics:[],stderr:[],
 mode,loadBefore:loadavg(),timerResolutionMs:timerResolution(),startedAt:new Date().toISOString(),
 imageCompressedBytes:image.length,
 node:process.version,v8:process.versions.v8,manifest,identities:{image:sha(image),artifact:sha(binary),kernel:sha(readFileSync(kernel))}};
if(!['timing','resource'].includes(mode))throw Error('invalid measurement mode');
const save=()=>writeFileSync(resolve(output,'result.json'),JSON.stringify(report,null,2)+'\n');
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const host=new NodeKernelHost({rootfsImage:image,maxWorkers:24,offlineEgressLink:true,onHostDiagnostic:(e:unknown)=>report.diagnostics.push(e),
 onStderr:(pid:number,b:Uint8Array)=>report.stderr.push({pid,text:new TextDecoder().decode(b)})});
const timeout=setTimeout(()=>{report.timeout=true;save();void host.destroy();},300000);
try{
 const initialized=performance.now();await host.init(Uint8Array.from(readFileSync(kernel)).buffer);report.initMs=performance.now()-initialized;
 report.trial=await wordpressTrial(host,Uint8Array.from(binary).buffer,{label:arm,backend,
  wpConfig:renderWordPressConfig('selectable','/','http'),warmup:3,rounds:5,validateTimestamps:true,
  checkTimestampPolicy:true,sharedFileCache:fileCache==='on'?'/var/cache/opcache':'',diagnosticLog:report.diagnostic,
  checkSeededCore:report.diagnostic,
  persist:(trial:unknown)=>{report.trial=trial;save();}});
 if(!report.trial.passed)throw Error(report.trial.error??'WordPress trial failed');
 report.imageAndServiceMs=report.initMs+report.trial.preparationMs+report.trial.firstHomepageMs;
 const log=report.trial.logs?.['/tmp/seed-opcache.log']??'';
 report.loadedScripts=[...log.matchAll(/File cached script loaded into memory '([^']+)'/g)].map(m=>m[1]);
 if(report.diagnostic&&manifest.seedFiles&&report.loadedScripts.length<100)throw Error('seed was not restored into WordPress shared cache');
 if(report.diagnostics.length)throw Error('host diagnostic during trial');
 if(mode==='resource'){
  report.os=await physicalFootprint(process.pid,output,'warm-os');
  report.nodeMemory=process.memoryUsage();report.inspection=await host.inspectProcesses();
  report.kernelLinearBytes=(await host.getKernelMemoryPages())*65536;
  report.fileCacheInventory=await fileCacheInventory(host);
 }
 report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{clearTimeout(timeout);await host.destroy();report.destroyed=true;report.loadAfter=loadavg();save();console.log(JSON.stringify({passed:report.passed,backend,
 firstHomepageMs:report.trial?.firstHomepageMs,loadedScripts:report.loadedScripts?.length,error:report.error}));}
