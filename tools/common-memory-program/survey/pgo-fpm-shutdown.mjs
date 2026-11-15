// Correctness/training diagnostic, never a performance ranking.
// SIGQUIT must let both real FPM workers flush before the master exits.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {fastcgi} from '../platform/fastcgi.mjs';
const [profile,artifact,out]=process.argv.slice(2,5).map(p=>resolve(p));
const shared=process.argv[5]==='shared',requireProfiles=process.argv.includes('--require-profiles');
const controlTimeout=Number(process.argv.find(a=>a.startsWith('--control-timeout='))?.split('=')[1]??0);
assert.ok(Number.isInteger(controlTimeout)&&controlTimeout>=0&&controlTimeout<=60);
if(existsSync(out))throw Error('choose a fresh output directory');mkdirSync(out,{recursive:true});
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')));
const result={scope:'Node FPM graceful shutdown/profile collection; no timing claim',shared,requireProfiles,controlTimeoutSeconds:controlTimeout,runtime:process.version,
 artifactSha256:createHash('sha256').update(readFileSync(artifact)).digest('hex'),stdout:'',stderr:'',diagnostics:[],events:[],responses:[],profiles:[]};
const host=new NodeKernelHost({rootfsImage:readFileSync('local-binaries/partial/shell-partial.vfs.zst'),maxWorkers:4,
 onStdout:(_pid,b)=>result.stdout+=new TextDecoder().decode(b),onStderr:(_pid,b)=>result.stderr+=new TextDecoder().decode(b),
 onHostDiagnostic:e=>result.diagnostics.push(e),onProcessEvent:e=>result.events.push(e)});
const bytes=s=>new TextEncoder().encode(s);
const timeout=setTimeout(()=>{result.timeout=true;void host.destroy();},180000);
try {
 await host.init();
 await host.writeFileToVfs('/tmp/profile-fpm.wasm',readFileSync(artifact),0o755);
 await host.writeFileToVfs('/tmp/profile.php',bytes('<?php $local=($local??0)+1; echo json_encode(["pid"=>getmypid(),"answer"=>array_sum(range(1,100)),"private"=>$local]);'));
 await host.writeFileToVfs('/tmp/profile-fpm.conf',bytes(`[global]\npid=/tmp/profile-fpm.pid\nerror_log=/tmp/profile-fpm.log\ndaemonize=no\nprocess_control_timeout=${controlTimeout}s\n[probe]\nlisten=127.0.0.1:18974\npm=static\npm.max_children=2\npm.max_requests=0\ncatch_workers_output=yes\nclear_env=no\nchdir=/tmp\n`));
 const launched=await host.spawnFromVfs('/tmp/profile-fpm.wasm',['php-fpm','-n','-F','-y','/tmp/profile-fpm.conf',
  '-d','opcache.enable=1','-d',`opcache.file_cache_only=${shared?0:1}`,'-d',`opcache.file_cache=${shared?'':'/tmp'}`,
  '-d','opcache.memory_consumption=8','-d','opcache.interned_strings_buffer=1','-d','opcache.validate_timestamps=0',
  '-d','opcache.file_update_protection=0','-d','opcache.jit_buffer_size=0'],{
   cwd:'/tmp',env:['HOME=/tmp','PATH=/usr/bin:/bin','LLVM_PROFILE_FILE=/tmp/php-fpm-training-%m.profraw'],uid:1000,gid:1000,stdin:new Uint8Array()});
 result.master=launched.pid;
 launched.exit.then(code=>result.serverExit=code,error=>result.serverExit=String(error));
 const deadline=Date.now()+60000;
 while(!await host.pickListenerTarget(18974)) {
  assert.equal(result.serverExit,undefined,'FPM exited during startup');assert.ok(Date.now()<deadline,'listener deadline');
  await new Promise(r=>setTimeout(r,1));
 }
 for(let round=0;round<4;round++)await Promise.all([0,1].map(async()=>{
  const response=await fastcgi(host,18974,'/tmp/profile.php');assert.equal(response.stderr,'');
  const body=JSON.parse(response.body);assert.equal(body.answer,5050);assert.equal(body.private,1);result.responses.push(body);
 }));
 result.workers=[...new Set(result.responses.map(r=>r.pid))];assert.equal(result.workers.length,2);
 result.quitSignal=3;const quitting=Date.now();await host.signalProcess(launched.pid,result.quitSignal);
 result.serverExit=await launched.exit;assert.equal(result.serverExit,0);
 result.quitElapsedMs=Date.now()-quitting;
 for(const pid of [result.master,...result.workers]) {
  const exit=result.events.find(e=>e.kind==='exit'&&e.pid===pid);assert.ok(exit,`missing exit event for${pid}`);assert.equal(exit.exitStatus,0);
 }
 for(const entry of await host.readDirFromVfs('/tmp'))if(entry.name.startsWith('php-fpm-training-')&&entry.name.endsWith('.profraw')) {
  const b=await host.readFileFromVfs('/tmp/'+entry.name);assert.ok(b?.length);writeFileSync(resolve(out,entry.name),b);
  result.profiles.push({name:entry.name,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
 }
 if(requireProfiles)assert.ok(result.profiles.length,'no FPM training profiles');
 result.memory=await host.commonMemoryPrototypeStats();
 assert.equal(result.stderr,'');assert.deepEqual(result.diagnostics,[]);assert.ok(!result.timeout);result.passed=true;
} catch(error) {result.error=String(error.stack||error);}
finally {
 clearTimeout(timeout);
 try {result.fpmLog=new TextDecoder().decode(await host.readFileFromVfs('/tmp/profile-fpm.log'));}catch(error){result.logReadError=String(error);}
 await host.destroy();result.destroyed=true;writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');
}
console.log(JSON.stringify(result));if(!result.passed)throw Error('FPM graceful shutdown/profile collection failed');
