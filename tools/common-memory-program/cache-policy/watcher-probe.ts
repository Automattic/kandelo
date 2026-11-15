// Capability experiment, not a production timestamp replacement. A controlled
// request waits for observer-driven invalidation. Unfenced nginx traffic and
// edits during an existing request have no coherence guarantee from this API.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {fastcgi} from '../platform/fastcgi.mjs';
const [image,fixture,profile,kernel,output]=process.argv.slice(2,7).map(p=>resolve(p));
const validation=process.argv[7]??'0';if(!['0','1'].includes(validation))throw Error('invalid validation control');
mkdirSync(output);const binary=readFileSync(resolve(fixture,'translated-fpm.wasm'));
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const target='/srv/www/html/kandelo-seed-target.php',control='/srv/www/html/kandelo-seed-control.php';
const encode=(s:string)=>new TextEncoder().encode(s);
const result:any={scope:'Controlled requests, both FPM workers; observer is a bounded hint, not general coherence',
 passed:false,validation,identities:{image:sha(readFileSync(image)),binary:sha(binary),kernel:sha(readFileSync(kernel))},events:[],cases:[],diagnostics:[],stderr:[]};
const save=()=>writeFileSync(resolve(output,'result.json'),JSON.stringify(result,null,2)+'\n');
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const host=new NodeKernelHost({rootfsImage:readFileSync(image),maxWorkers:8,offlineEgressLink:true,
 onHostDiagnostic:(e:unknown)=>result.diagnostics.push(e),onStderr:(pid:number,b:Uint8Array)=>result.stderr.push({pid,text:new TextDecoder().decode(b)})});
const code=(v:number)=>`<?php return ['version'=>${v},'answer'=>array_sum(range(1,1000))];`;
const timeout=setTimeout(()=>{result.timeout=true;save();void host.destroy();},180000);
const dirty=new Set<string>();let off=()=>{},launched:any;
async function until(check:()=>boolean|Promise<boolean>,label:string){const deadline=performance.now()+15000;
 while(!await check()){if(performance.now()>deadline)throw Error('deadline: '+label);await new Promise(r=>setTimeout(r,5));}}
async function call(action:string){const response=await fastcgi(host,18973,control,action);
 if(response.stderr)throw Error(response.stderr);try{return JSON.parse(response.body);}catch{throw Error('invalid JSON: '+response.body.slice(0,1000));}}
async function reads(version:number,name:string){const values:any[]=[];
 await until(async()=>{
  values.push(...await Promise.all(Array.from({length:8},()=>call('action=read'))));
  return new Set(values.map(r=>r.pid)).size===2;
 },name+': both workers ready');
 result.cases.push({name,expectedVersion:version,replies:values});save();
 if(new Set(values.map(r=>r.pid)).size!==2||values.some(r=>r.value?.version!==version||r.validate!==validation||r.fileOnly!=='0'))throw Error(name+': wrong version/config/worker coverage');
}
async function barrier(){const before=result.events.length;
 await host.writeFileToVfs('/srv/www/html/watch-sentinel',encode(String(before)));
 await until(()=>result.events.slice(before).some((e:any)=>e.path.endsWith('/watch-sentinel')),'observer barrier');}
async function flush(){if(!dirty.has(target))return;dirty.delete(target);
 const response=await call('action=invalidate');result.cases.push({name:'invalidation',response});save();
 if(!response.invalidated)throw Error('shared invalidation did not find target');}
try{
 await host.init(Uint8Array.from(readFileSync(kernel)).buffer);
 await host.writeFileToVfs('/usr/sbin/php-fpm',Uint8Array.from(binary),0o755);
 await host.writeFileToVfs(control,encode(`<?php
header('Content-Type: application/json');
$target='${target}';$action=$_GET['action']??'read';$version=(int)($_GET['version']??2);
$code=${JSON.stringify(code(1))};$code=str_replace("version'=>1","version'=>".$version,$code);
$out=['pid'=>getmypid(),'action'=>$action,'validate'=>ini_get('opcache.validate_timestamps'),'fileOnly'=>ini_get('opcache.file_cache_only')];
if($action==='edit') { file_put_contents($target,$code);touch($target,315532800); }
if($action==='replace') { file_put_contents('/tmp/watch-replacement',$code);touch('/tmp/watch-replacement',315532800);rename('/tmp/watch-replacement',$target); }
if($action==='invalidate')$out['invalidated']=opcache_invalidate($target,true);
if($action==='alias') { link($target,'/var/cache/opcache/watch-outside-alias');file_put_contents('/var/cache/opcache/watch-outside-alias',$code);touch($target,315532920); }
if($action==='open-write') {
 $file=fopen($target,'c+');fwrite($file,$code);fflush($file);touch($target,315532860);
 file_put_contents('/tmp/watch-ready','ready');
 $deadline=microtime(true)+15;do {clearstatcache(true,'/tmp/watch-release');if(file_exists('/tmp/watch-release'))break;usleep(1000);}while(microtime(true)<$deadline);
 fclose($file);
}
if($action==='read'){$out['value']=include $target;$out['cached']=opcache_is_script_cached($target);usleep(10000);}
echo json_encode($out);
`));
 launched=await host.spawnFromVfs('/usr/sbin/php-fpm',['php-fpm','-n','-F','-y','/etc/kandelo-seed-fpm.conf',
  '-d','opcache.enable=1','-d','opcache.file_cache_only=0','-d','opcache.file_cache=/var/cache/opcache',
  '-d','opcache.memory_consumption=32','-d','opcache.interned_strings_buffer=4','-d','opcache.file_update_protection=0',
  '-d',`opcache.validate_timestamps=${validation}`,'-d','opcache.revalidate_freq=0','-d','opcache.jit_buffer_size=0',
  '-d','opcache.blacklist_filename=/etc/kandelo-seed-blacklist'],{cwd:'/srv/www/html',uid:65534,gid:65534,
   env:['PATH=/usr/bin:/bin','HOME=/tmp','TMPDIR=/tmp'],stdin:new Uint8Array()});
 launched.exit.then((v:number)=>{result.exit=v;save();},(e:unknown)=>{result.exit=String(e);save();});
 await until(()=>host.pickListenerTarget(18973),'FPM listener');
 off=host.subscribeVfsChanges('/srv/www/html',(event:any)=>{result.events.push(event);if(event.path===target||event.path==='/srv/www/html')dirty.add(target);});
 await barrier();dirty.clear();await reads(1,'seed baseline');
 await call('action=edit&version=2');await barrier();await flush();await reads(2,'guest same-mtime close plus invalidation');
 await call('action=replace&version=3');await barrier();await flush();await reads(3,'atomic replacement plus invalidation');
 // Open-file writes become visible before a close hint. Even an observer
 // completion barrier cannot recover an event the kernel has not published.
 const held=call('action=open-write&version=4');
 await until(async()=>!!await host.readFileFromVfs('/tmp/watch-ready'),'write completed while FD held');
 await barrier();await flush();
 const during=await call('action=read');const bytes=await host.readFileFromVfs(target);
 result.cases.push({name:'open writable descriptor gap',response:during,disk:new TextDecoder().decode(bytes!),pending:dirty.has(target)});save();
 if(during.value?.version!==(validation==='1'?4:3)||!new TextDecoder().decode(bytes!).includes("'version'=>4"))throw Error('open-FD control had wrong code version');
 await host.writeFileToVfs('/tmp/watch-release',encode('release'));await held;await barrier();await flush();await reads(4,'close makes version4 invalidation possible');
 await call('action=alias&version=5');await barrier();await flush();
 // The opening name outside the watched tree still names the correct inode;
 // existing path hints cannot infer the other hard link inside the tree.
 const alias=await call('action=read'),disk=await host.readFileFromVfs(target);
 result.cases.push({name:'outside hardlink gap',response:alias,disk:new TextDecoder().decode(disk!),pending:dirty.has(target)});save();
 if(alias.value?.version!==(validation==='1'?5:4)||!new TextDecoder().decode(disk!).includes("'version'=>5"))throw Error('alias control had wrong code version');
 await call('action=invalidate');await reads(5,'explicit invalidation recovers alias edit');
 if(result.diagnostics.length)throw Error('host diagnostics');result.passed=true;
}catch(error){result.error=String(error);process.exitCode=1;}
finally{off();if(launched&&result.exit===undefined){await host.signalProcess(launched.pid,15).catch(()=>false);await Promise.race([launched.exit.catch(()=>undefined),new Promise(r=>setTimeout(r,3000))]);}
 await host.destroy();clearTimeout(timeout);result.destroyed=true;save();console.log(JSON.stringify({passed:result.passed,cases:result.cases.map((c:any)=>c.name),error:result.error}));}
