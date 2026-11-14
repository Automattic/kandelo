import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fastcgi} from './fastcgi.mjs';
import {checkOpcache} from './check-opcache.mjs';
const [profile,artifact,output]=process.argv.slice(2,5).map(p=>resolve(p));
const shared=process.argv[5]==='shared';
mkdirSync(output,{recursive:true});
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const stdout=[],stderr=[],diagnostics=[],processEvents=[];
const host=new NodeKernelHost({rootfsImage:readFileSync('local-binaries/partial/shell-partial.vfs.zst'),maxWorkers:6,
  onStdout:(pid,bytes)=>stdout.push({pid,text:new TextDecoder().decode(bytes)}),
  onStderr:(pid,bytes)=>stderr.push({pid,text:new TextDecoder().decode(bytes)}),
  onHostDiagnostic:e=>{diagnostics.push(e);console.error(JSON.stringify(e));},
  onProcessEvent:e=>processEvents.push(e),
});
const encode=s=>new TextEncoder().encode(s);
let serverExit,master,requests=[];
const trace=[];
const details={};
function save(extra={}) {Object.assign(details,extra);writeFileSync(resolve(output,'fpm-result.json'),JSON.stringify({shared,master,serverExit,stdout,stderr,diagnostics,requests,trace,processEvents,...details},null,2)+'\n');}
const timeout=setTimeout(()=>{console.error('FPM trial deadline');save({timeout:true});void host.destroy();},180000);
try {
  await host.init();
  if(process.env.KANDELO_VM_TRACE==='1') host.subscribeSyscalls(event=>trace.push(event));
  await host.writeFileToVfs('/tmp/vm-fpm.wasm',new Uint8Array(readFileSync(artifact)),0o755);
  await host.writeFileToVfs('/tmp/vm-fpm.conf',encode(`[global]\npid=/tmp/vm-fpm.pid\nerror_log=/tmp/vm-fpm.log\ndaemonize=no\n[probe]\nlisten=127.0.0.1:18973\npm=static\npm.max_children=2\npm.max_requests=0\ncatch_workers_output=yes\nclear_env=no\nchdir=/tmp\n`));
  await host.writeFileToVfs('/tmp/vm-probe.php',encode(`<?php
usleep(20000);
$local=($local??0)+1;
echo json_encode(["pid"=>getmypid(),"private"=>$local,"answer"=>array_sum(range(1,1000)),"file_cache_only"=>ini_get("opcache.file_cache_only"),"opcache"=>opcache_get_status(false)]);
`));
  const launched=await host.spawnFromVfs('/tmp/vm-fpm.wasm',['php-fpm','-n','-F','-y','/tmp/vm-fpm.conf',
    '-d','opcache.enable=1','-d',`opcache.file_cache_only=${shared?0:1}`,'-d',`opcache.file_cache=${shared?'':'/tmp'}`,
    '-d','opcache.memory_consumption=8','-d','opcache.interned_strings_buffer=1','-d','opcache.file_update_protection=0',
    '-d','opcache.validate_timestamps=0','-d','opcache.jit_buffer_size=0'],
    {cwd:'/tmp',env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],uid:1000,gid:1000,stdin:new Uint8Array()});
  master=launched.pid;
  launched.exit.then(code=>{serverExit=code;save();},error=>{serverExit=String(error);save();});
  const deadline=performance.now()+60000;
  while(!await host.pickListenerTarget(18973)) {
    if(serverExit!==undefined) throw Error(`FPM exited ${serverExit}`);
    if(performance.now()>deadline) throw Error('FPM listener deadline');
    await new Promise(r=>setTimeout(r,10));
  }
  requests=await Promise.all(Array.from({length:4},()=>fastcgi(host,18973,'/tmp/vm-probe.php')));
  // Listener readiness precedes completion of both child launches. Observe
  // both through bounded real work; retain every initial/extra response.
  let startupBatches=1;
  while(!shared && new Set(requests.map(r=>JSON.parse(r.body).pid)).size<2 && startupBatches<9) {
    requests.push(...await Promise.all(Array.from({length:4},()=>fastcgi(host,18973,'/tmp/vm-probe.php'))));
    startupBatches++;
  }
  save({startupBatches});
  for(const response of requests) {
    response.json=JSON.parse(response.body);
    assert.equal(response.json.answer,500500);assert.equal(response.json.private,1);
    assert.equal(response.json.file_cache_only,shared?'0':'1');
    if(shared) assert.equal(response.json.opcache?.opcache_enabled,true);
  }
  if(shared) {
    const checks=await checkOpcache(host,18973,processEvents,evidence=>save({opcacheChecks:evidence}));
    assert.ok(new Set(checks.requests.map(r=>r.json.pid)).size>=2,'both FPM workers must serve requests');
  } else assert.equal(new Set(requests.map(r=>r.json.pid)).size,2,'both FPM workers must serve requests');
  const log=await host.readFileFromVfs('/tmp/vm-fpm.log');
  save({passed:true,fpmLog:log?new TextDecoder().decode(log):null});
  console.log(`FPM ${shared?'shared':'file-cache'} smoke passed; worker PIDs ${[...new Set(requests.map(r=>r.json.pid))]}`);
  await host.signalProcess(master,15);
  await launched.exit;
} catch(error) {
  const log=await host.readFileFromVfs('/tmp/vm-fpm.log').catch(()=>null);
  save({error:String(error.stack||error),fpmLog:log?new TextDecoder().decode(log):null});throw error;
} finally {clearTimeout(timeout);await host.destroy();}
