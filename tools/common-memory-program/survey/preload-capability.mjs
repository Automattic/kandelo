// APP01 diagnostic only: establish effective preload behavior before choosing
// ordinary/VM timing controls. Request functions/classes prove worker uptake.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {fastcgi} from '../platform/fastcgi.mjs';
const [profile,artifact,out]=process.argv.slice(2,5).map(p=>resolve(p)),mode=process.argv[5];
if(!['native-file','vm-file','vm-shared','vm-shared-no-preload'].includes(mode)||existsSync(out))throw Error('fresh output and explicit capability mode required');
mkdirSync(out);const shared=mode.startsWith('vm-shared'),preload=mode!=='vm-shared-no-preload';
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const result={diagnostic:'preload-capability-v1',mode,shared,preload,artifactSha256:createHash('sha256').update(readFileSync(artifact)).digest('hex'),stdout:[],stderr:[],diagnostics:[],requests:[],passed:false};
const encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b);
const save=()=>writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');
const host=new NodeKernelHost({rootfsImage:readFileSync('local-binaries/partial/shell-partial.vfs.zst'),maxWorkers:6,
 onStdout:(pid,b)=>result.stdout.push({pid,text:decode(b)}),onStderr:(pid,b)=>result.stderr.push({pid,text:decode(b)}),onHostDiagnostic:e=>result.diagnostics.push(e)});
let master,exit,serverExit;const watchdog=setTimeout(()=>{result.timeout=true;save();void host.destroy();},90000);
try{
 await host.init(Uint8Array.from(readFileSync('local-binaries/source-only-v1/kernel.wasm')).buffer);
 await host.writeFileToVfs('/tmp/preload-fpm.wasm',Uint8Array.from(readFileSync(artifact)),0o755);
 await host.writeFileToVfs('/tmp/preload-fpm.conf',encode('[global]\ndaemonize=no\nerror_log=/tmp/preload-fpm.log\n[probe]\nlisten=127.0.0.1:18974\npm=static\npm.max_children=2\nclear_env=no\nchdir=/tmp\n'));
 await host.writeFileToVfs('/tmp/preload-target.php',encode('<?php function kandelo_preloaded_value(){return 37;} class KandeloPreloaded {const VALUE=41;}'),0o644);
 await host.writeFileToVfs('/tmp/preload-start.php',encode("<?php $ok=opcache_compile_file('/tmp/preload-target.php');file_put_contents('/tmp/preload-marker.json',json_encode(['compiled'=>$ok,'pid'=>getmypid()]));"),0o644);
 await host.writeFileToVfs('/tmp/preload-request.php',encode(`<?php usleep(20000);$s=opcache_get_status(false);echo json_encode(['pid'=>getmypid(),'answer'=>array_sum(range(1,1000)),'file_cache_only'=>ini_get('opcache.file_cache_only'),'function'=>function_exists('kandelo_preloaded_value'),'class'=>class_exists('KandeloPreloaded',false),'value'=>function_exists('kandelo_preloaded_value')?kandelo_preloaded_value():null,'class_value'=>class_exists('KandeloPreloaded',false)?KandeloPreloaded::VALUE:null,'preload'=>$s['preload_statistics']??null]);`),0o644);
 const args=['php-fpm','-n','-F','-y','/tmp/preload-fpm.conf','-d','opcache.enable=1','-d',`opcache.file_cache_only=${shared?0:1}`,'-d',`opcache.file_cache=${shared?'':'/tmp'}`,'-d','opcache.memory_consumption=8','-d','opcache.interned_strings_buffer=1','-d','opcache.file_update_protection=0','-d','opcache.validate_timestamps=0','-d','opcache.jit_buffer_size=0'];
 if(preload)args.push('-d','opcache.preload=/tmp/preload-start.php');
 result.args=args;const launched=await host.spawnFromVfs('/tmp/preload-fpm.wasm',args,{cwd:'/tmp',env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],uid:1000,gid:1000,stdin:new Uint8Array()});master=launched.pid;exit=launched.exit;exit.then(c=>serverExit=c,e=>serverExit=String(e));
 const deadline=performance.now()+45000;while(!await host.pickListenerTarget(18974)){if(serverExit!==undefined)throw Error('FPM startup exit '+serverExit);if(performance.now()>deadline)throw Error('FPM listener deadline');await new Promise(r=>setTimeout(r,10));}
 for(let attempt=0;attempt<5;attempt++){
  const responses=await Promise.all(Array.from({length:4},()=>fastcgi(host,18974,'/tmp/preload-request.php')));
  for(const r of responses)result.requests.push({...r,json:JSON.parse(r.body)});
  if(new Set(result.requests.map(r=>r.json.pid)).size===2)break;
 }
 if(new Set(result.requests.map(r=>r.json.pid)).size!==2)throw Error('both workers must answer');
 const marker=await host.readFileFromVfs('/tmp/preload-marker.json');result.marker=marker?JSON.parse(decode(marker)):null;
 for(const r of result.requests){const q=r.json;if(q.answer!==500500||q.file_cache_only!==(shared?'0':'1'))throw Error('normal request/cache contract');if(q.function!==q.class)throw Error('partial preload registration');if(q.function&&(q.value!==37||q.class_value!==41))throw Error('preloaded definitions wrong');}
 const active=result.requests.every(r=>r.json.function);if(!active&&result.requests.some(r=>r.json.function))throw Error('workers disagree on preload');
 result.effective=active?'preloaded':'not-preloaded';
 if(shared&&preload&&(!active||!result.marker?.compiled||!result.requests.every(r=>r.json.preload)))throw Error('shared preload positive control failed');
 if(!preload&&(active||result.marker))throw Error('no-preload negative control failed');
 if(result.diagnostics.length)throw Error('host diagnostics');result.passed=true;
}catch(error){result.error=String(error.stack||error);process.exitCode=1;}
finally{
 const log=await host.readFileFromVfs('/tmp/preload-fpm.log').catch(()=>null);result.fpmLog=log?decode(log):null;result.serverExit=serverExit;
 try{if(master&&serverExit===undefined){await host.signalProcess(master,15);await exit;}}finally{await host.destroy();result.destroyed=true;clearTimeout(watchdog);save();}
}
console.log(JSON.stringify({passed:result.passed,mode,effective:result.effective,marker:result.marker,error:result.error}));
