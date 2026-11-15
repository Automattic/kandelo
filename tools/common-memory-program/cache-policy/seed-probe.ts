// Mechanism screen only: standard PHP FILE-cache persistence and SHM loading.
// These stages share a Node parent and must not become cold latency samples.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {KandeloImageFs} from '../../../images/vfs/lib/kandelo-image-fs';
import {saveImage,sourceDateEpochMilliseconds} from '../../../images/vfs/scripts/vfs-image-helpers';
import {ensureDirRecursive,writeVfsFile,writeVfsBinary} from '../../../host/src/vfs/image-helpers';
import {fastcgi} from '../platform/fastcgi.mjs';
const [fixture,profile,kernel,output]=process.argv.slice(2).map(p=>resolve(p));
mkdirSync(output);const manifest=JSON.parse(readFileSync(resolve(fixture,'manifest.json'),'utf8'));
const binary=readFileSync(resolve(fixture,'translated-fpm.wasm'));
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
if(sha(binary)!==manifest.translatedFpmSha256)throw Error('FPM identity mismatch');
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const target='/srv/www/html/kandelo-seed-target.php',control='/srv/www/html/kandelo-seed-control.php';
const source=(v:number)=>`<?php return ['version'=>${v},'answer'=>array_sum(range(1,1000))];`;
const result:any={scope:'Standard PHP seed capability, not timing or a fresh-parent performance comparison',
  artifactSha256:sha(binary),kernelSha256:sha(readFileSync(kernel)),stages:[],passed:false};
const save=()=>writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');
function imageFs(version=1){const fs=KandeloImageFs.create();fs.loadImage(readFileSync(manifest.image));
 writeVfsFile(fs,target,source(version));
 fs.chown(target,65534,65534);
 writeVfsFile(fs,control,`<?php
header('Content-Type: application/json');
$target='${target}';$action=$_GET['action']??'read';$compiled=null;
if($action==='compile')$compiled=opcache_compile_file($target);
if($action==='edit') { file_put_contents($target,${JSON.stringify(source(2))}); touch($target,1600000060); }
$before=opcache_is_script_cached($target);
$value=$action==='read'?include $target:null;
usleep(10000);
echo json_encode(['pid'=>getmypid(),'compiled'=>$compiled,'before'=>$before,
 'after'=>opcache_is_script_cached($target),'value'=>$value,
 'file_cache_only'=>ini_get('opcache.file_cache_only'),'file_cache'=>ini_get('opcache.file_cache'),
 'validate_timestamps'=>ini_get('opcache.validate_timestamps'),'status'=>opcache_get_status(false)]);
`);
 writeVfsFile(fs,'/etc/kandelo-seed-blacklist',control+'\n');
 writeVfsFile(fs,'/etc/kandelo-seed-fpm.conf','[global]\npid=/tmp/seed-fpm.pid\nerror_log=/tmp/seed-fpm.log\ndaemonize=no\n[probe]\nlisten=127.0.0.1:18973\npm=static\npm.max_children=2\npm.max_requests=0\ncatch_workers_output=yes\nclear_env=no\nchdir=/srv/www/html\n');
 return fs;
}
async function build(fs:any,name:string,epoch=sourceDateEpochMilliseconds()){const path=resolve(output,name+'.vfs.zst');await saveImage(fs,path,{normalizeTimestampsMs:epoch});return path;}
async function run(name:string,image:string,shared:boolean,version=1,checkEdit=false){
 const stage:any={name,imageSha256:sha(readFileSync(image)),shared,diagnostics:[],stderr:[],requests:[]};result.stages.push(stage);save();
 const host=new NodeKernelHost({rootfsImage:readFileSync(image),maxWorkers:8,
  onHostDiagnostic:(e:unknown)=>stage.diagnostics.push(e),onStderr:(pid:number,b:Uint8Array)=>stage.stderr.push({pid,text:new TextDecoder().decode(b)})});
 let launched:any;const timeout=setTimeout(()=>{stage.timeout=true;save();void host.destroy();},120000);
 try{
  await host.init(Uint8Array.from(readFileSync(kernel)).buffer);
  await host.writeFileToVfs('/usr/sbin/php-fpm',Uint8Array.from(binary),0o755);
  launched=await host.spawnFromVfs('/usr/sbin/php-fpm',['php-fpm','-n','-F','-y','/etc/kandelo-seed-fpm.conf',
   '-d','opcache.enable=1','-d',`opcache.file_cache_only=${shared?0:1}`,'-d','opcache.file_cache=/var/cache/opcache',
   '-d','opcache.memory_consumption=32','-d','opcache.interned_strings_buffer=4','-d','opcache.file_update_protection=0',
   '-d','opcache.validate_timestamps=1','-d','opcache.revalidate_freq=0','-d','opcache.jit_buffer_size=0',
   '-d','opcache.blacklist_filename=/etc/kandelo-seed-blacklist','-d','opcache.log_verbosity_level=4','-d','opcache.error_log=/tmp/seed-opcache.log'],
   {cwd:'/srv/www/html',uid:65534,gid:65534,env:['PATH=/usr/bin:/bin','HOME=/tmp','TMPDIR=/tmp'],stdin:new Uint8Array()});
  launched.exit.then((code:number)=>{stage.exit=code;save();},(error:unknown)=>{stage.exit=String(error);save();});
  const deadline=performance.now()+60000;
  while(!await host.pickListenerTarget(18973)){
   if(stage.exit!==undefined)throw Error('FPM exited: '+stage.exit);
   if(performance.now()>deadline)throw Error('FPM listener deadline');
   await new Promise(r=>setTimeout(r,10));
  }
  for(let round=0;round<4;round++){
   const replies=await Promise.all(Array.from({length:2},()=>fastcgi(host,18973,control,'action=read')));
   for(const reply of replies){if(reply.stderr)throw Error(reply.stderr);const data=JSON.parse(reply.body);
    if(data.file_cache_only!==(shared?'0':'1')||data.file_cache!=='/var/cache/opcache'||data.validate_timestamps!=='1')throw Error('effective config mismatch');
    if(data.value?.version!==version||data.value.answer!==500500)throw Error('wrong cached result');
    if(shared&&(!data.after||!data.status?.opcache_enabled))throw Error('SHM cache absent');
    stage.requests.push(data);save();}
   if(new Set(stage.requests.map((r:any)=>r.pid)).size===2)break;
  }
  if(new Set(stage.requests.map((r:any)=>r.pid)).size!==2)throw Error('both workers must answer');
  if(checkEdit){
   const reply=await fastcgi(host,18973,control,'action=edit');stage.editResponse=reply.body;if(reply.stderr)throw Error(reply.stderr);
   stage.edit=JSON.parse(reply.body);stage.afterEdit=[];
   for(let round=0;round<4;round++){
    const replies=await Promise.all(Array.from({length:2},()=>fastcgi(host,18973,control,'action=read')));
    for(const reply of replies){if(reply.stderr)throw Error(reply.stderr);const data=JSON.parse(reply.body);
     if(data.value?.version!==2||data.value.answer!==500500)throw Error('seeded cache did not notice edit');
     stage.afterEdit.push(data);}
    if(new Set(stage.afterEdit.map((r:any)=>r.pid)).size===2)break;
   }
   if(new Set(stage.afterEdit.map((r:any)=>r.pid)).size!==2)throw Error('edit must be observed by both workers');
  }
  const files:Array<{path:string;bytes:Uint8Array;mode:number}>=[];const queue=['/var/cache/opcache'];
  while(queue.length){const dir=queue.shift()!;const entries=await host.readDirFromVfs(dir);if(!entries)throw Error('cache directory missing');
   for(const entry of entries){if(entry.name==='.'||entry.name==='..')continue;const path=dir+'/'+entry.name;
    if((entry.mode&0xf000)===0x4000)queue.push(path);else{const bytes=await host.readFileFromVfs(path);if(!bytes)throw Error('missing cache file');
     if(Buffer.from(bytes.subarray(0,8)).toString('hex')!=='4f50434143484500')throw Error('invalid produced cache magic');
     files.push({path,bytes,mode:entry.mode&0o777});}}
  }
  stage.files=files.map(f=>({path:f.path,bytes:f.bytes.length,sha256:sha(f.bytes),mode:f.mode}));
  const log=await host.readFileFromVfs('/tmp/seed-opcache.log');stage.opcacheLog=log?new TextDecoder().decode(log):'';
  stage.loadedFromFile=stage.opcacheLog.includes(`File cached script loaded into memory '${target}'`);
  stage.passed=true;save();return files;
 }catch(error){stage.error=String(error);throw error;}
 finally{
  if(launched&&stage.exit===undefined){await host.signalProcess(launched.pid,15).catch(()=>false);await Promise.race([launched.exit.catch(()=>undefined),new Promise(r=>setTimeout(r,3000))]);}
  const log=await host.readFileFromVfs('/tmp/seed-fpm.log').catch(()=>null);stage.fpmLog=log?new TextDecoder().decode(log):null;
  await host.destroy();stage.destroyed=true;clearTimeout(timeout);save();
 }
}
try{
 const empty=await build(imageFs(),'empty');
 const seed=await run('train-file',empty,false);if(!seed.length)throw Error('FILE training produced no cache');
 function seedFs(version=1){const fs=imageFs(version);for(const file of seed){ensureDirRecursive(fs,file.path.slice(0,file.path.lastIndexOf('/')));writeVfsBinary(fs,file.path,file.bytes,file.mode);
  if(sha(fs.readFile(file.path))!==sha(file.bytes))throw Error('seed binary staging changed bytes');}
 function own(dir:string){fs.chown(dir,65534,65534);for(const name of fs.readDirNames(dir)){const child=dir+'/'+name;if((fs.lstat(child).mode&0xf000)===0x4000)own(child);else fs.chown(child,65534,65534);}}
 own('/var/cache/opcache');return fs;}
 const seeded=await build(seedFs(),'seeded');
 await run('shared-empty',empty,true);await run('shared-seeded',seeded,true,1,true);
 const stale=await build(seedFs(2),'stale-seed',sourceDateEpochMilliseconds()+60000);
 await run('shared-stale-seed',stale,true,2);
 if(result.stages[1].loadedFromFile)throw Error('empty control unexpectedly loaded file cache');
 if(!result.stages[2].loadedFromFile)throw Error('seed was not restored into SHM');
 if(result.stages[3].loadedFromFile)throw Error('stale seed was accepted despite timestamps');
 if(result.stages.some((s:any)=>!s.passed||!s.destroyed||s.diagnostics.length))throw Error('stage failed');
 result.passed=true;
}catch(error){result.error=String(error);process.exitCode=1;}
finally{save();console.log(JSON.stringify({passed:result.passed,error:result.error,stages:result.stages.map((s:any)=>({name:s.name,passed:s.passed,loadedFromFile:s.loadedFromFile,files:s.files?.length}))}));}
