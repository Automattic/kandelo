import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {KandeloImageFs} from '../../../images/vfs/lib/kandelo-image-fs';
import {saveImage,sourceDateEpochMilliseconds} from '../../../images/vfs/scripts/vfs-image-helpers';
import {ensureDirRecursive,writeVfsBinary} from '../../../host/src/vfs/image-helpers';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {wordpressTrial} from './wordpress-fixture.mjs';
const [fixture,profile,kernel,output,backend='sqlite',arm='vm-shared']=process.argv.slice(2);
if(!['vm-shared','native-file'].includes(arm))throw Error('unsupported seed training arm');
mkdirSync(output);const original=JSON.parse(readFileSync(resolve(fixture,'manifest.json'),'utf8'));
const binary=readFileSync(resolve(fixture,arm==='native-file'?'ordinary-fpm.wasm':'translated-fpm.wasm'));
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const report:any={backend,arm,passed:false,diagnostics:[],stderr:[],identities:{image:sha(readFileSync(original.image)),artifact:sha(binary),kernel:sha(readFileSync(kernel))},files:[],excluded:[]};
if(report.identities.image!==original.imageSha256||report.identities.artifact!==(arm==='native-file'?original.ordinaryFpmSha256:original.translatedFpmSha256))throw Error('training input identity mismatch');
const save=()=>writeFileSync(resolve(output,'training.json'),JSON.stringify(report,null,2)+'\n');
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const host=new NodeKernelHost({rootfsImage:readFileSync(original.image),maxWorkers:24,offlineEgressLink:true,
 onHostDiagnostic:(e:unknown)=>report.diagnostics.push(e),onStderr:(pid:number,b:Uint8Array)=>report.stderr.push({pid,text:new TextDecoder().decode(b)})});
const timeout=setTimeout(()=>{report.timeout=true;save();void host.destroy();},300000);
try{
 await host.init(Uint8Array.from(readFileSync(kernel)).buffer);
 // Train with the same effective ini as the intended consumer. PHP may fold
 // immutable configuration queries into compiled code stored in the seed.
 report.trial=await wordpressTrial(host,Uint8Array.from(binary).buffer,{label:arm,backend,sharedFileCache:'/var/cache/opcache',
  wpConfig:renderWordPressConfig('selectable','/','http'),warmup:1,rounds:1,validateTimestamps:true,persist:(trial:unknown)=>{report.trial=trial;save();}});
 if(!report.trial.passed)throw Error(report.trial.error??'training request failed');
 if(report.diagnostics.length)throw Error('host diagnostic during training');
 const fs=KandeloImageFs.create();fs.loadImage(readFileSync(original.image));
 const queue=['/var/cache/opcache'];
 while(queue.length){const dir=queue.shift()!,entries=await host.readDirFromVfs(dir);if(!entries)throw Error('missing cache directory');
  for(const entry of entries){if(entry.name==='.'||entry.name==='..')continue;const path=dir+'/'+entry.name;
   if((entry.mode&0xf000)===0x4000){queue.push(path);continue;}
   const bytes=await host.readFileFromVfs(path);if(!bytes)throw Error('missing cache file');
   if(Buffer.from(bytes.subarray(0,8)).toString('hex')!=='4f50434143484500')throw Error('invalid cache header');
   if(!path.endsWith('.php.bin'))throw Error('unexpected compiled-cache filename');
   const relative=path.slice('/var/cache/opcache/'.length),script=relative.slice(relative.indexOf('/'),-4);
   // A training request creates private runtime configuration too. Ship only
   // code whose bytes still match the immutable input image, never its secrets.
   let originalSource:Uint8Array|null=null;
   try{originalSource=fs.readFile(script);}catch{/* Generated source has no shipping entry. */}
   const trainedSource=await host.readFileFromVfs(script);
   if(!originalSource||!trainedSource||sha(originalSource)!==sha(trainedSource)){
    report.excluded.push({path,script,reason:'source absent from or differs from shipping image'});continue;
   }
   ensureDirRecursive(fs,dir);writeVfsBinary(fs,path,bytes,entry.mode&0o777);
   if(sha(fs.readFile(path))!==sha(bytes))throw Error('binary staging changed seed');
   report.files.push({path,bytes:bytes.length,sha256:sha(bytes)});
  }
 }
 if(report.files.length<100)throw Error('incomplete WordPress cache corpus');
 function own(dir:string){fs.chown(dir,65534,65534);for(const name of fs.readDirNames(dir)){const child=dir+'/'+name;if((fs.lstat(child).mode&0xf000)===0x4000)own(child);else fs.chown(child,65534,65534);}}
 own('/var/cache/opcache');
 const image=resolve(output,'wordpress-seeded.vfs.zst');
 const bytes=await saveImage(fs,image,{normalizeTimestampsMs:sourceDateEpochMilliseconds()});
 copyFileSync(resolve(fixture,'ordinary-fpm.wasm'),resolve(output,'ordinary-fpm.wasm'));
 copyFileSync(resolve(fixture,'translated-fpm.wasm'),resolve(output,'translated-fpm.wasm'));
 const manifest={...original,image,imageSha256:sha(bytes),cacheStartsEmpty:false,seedBackend:backend,
  seedFiles:report.files.length,seedLogicalBytes:report.files.reduce((n:number,f:any)=>n+f.bytes,0),seedFpmSha256:sha(binary),
  excludedSeedEntries:report.excluded.map((e:any)=>({script:e.script,reason:e.reason}))};
 writeFileSync(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 report.passed=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{clearTimeout(timeout);await host.destroy();report.destroyed=true;save();console.log(JSON.stringify({passed:report.passed,backend,files:report.files.length,error:report.error}));}
