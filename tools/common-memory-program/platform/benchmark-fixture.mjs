import {fastcgi} from './fastcgi.mjs';
const encode=s=>new TextEncoder().encode(s),decode=b=>new TextDecoder().decode(b);
const must=(condition,message)=>{if(!condition) throw Error(message);};
const response=`echo json_encode(['pid'=>getmypid(),'private'=>$local,'checksum'=>$checksum,'guest_ms'=>(hrtime(true)-$started)/1e6,'heap'=>memory_get_usage(true),'peak_heap'=>memory_get_peak_usage(true)]);`;
export function benchmarkFiles() {
  const files={};
  const prefix='<?php $started=hrtime(true); $local=($local??0)+1; ';
  files['empty.php']=prefix+'$checksum=0; '+response;
  files['compute.php']=prefix+`
$nodes=[];
for($i=0;$i<256;$i++) $nodes[]=(object)['value'=>$i,'next'=>null];
for($i=0;$i<256;$i++) $nodes[$i]->next=$nodes[($i+1)%256];
$checksum=0; $node=$nodes[0];
for($j=0;$j<64;$j++) for($i=0;$i<256;$i++){ $checksum+=$node->value; $node=$node->next; }
`+response;
  let includes=prefix+'$checksum=0;\n';
  for(let file=0;file<24;file++) {
    let source='<?php\n';
    for(let fn=0;fn<32;fn++) source+=`function bench_${file}_${fn}($x) { return $x+${file+fn}; }\n`;
    source+=`return bench_${file}_0(100);\n`;
    files[`lib-${file}.php`]=source;
    includes+=`$checksum+=include '/tmp/lib-${file}.php';\n`;
  }
  files['includes.php']=includes+response;
  files['meta.php']=`<?php
function bins($path,$depth=0) { $n=0; foreach(scandir($path) as $f) {
 if($f==='.' || $f==='..') continue; $p=$path.'/'.$f;
 if(is_dir($p) && $depth<5) $n+=bins($p,$depth+1); elseif(str_ends_with($f,'.bin')) $n++; } return $n; }
$d=[]; $previous=hrtime(true); for($i=0;$i<256;$i++){ $now=hrtime(true); if($now>$previous)$d[]=$now-$previous; $previous=$now; }
echo json_encode(['pid'=>getmypid(),'file_cache'=>ini_get('opcache.file_cache'),'file_cache_only'=>ini_get('opcache.file_cache_only'),
 'cache_bins'=>bins('/tmp'),'status'=>opcache_get_status(false),'clock_min_ns'=>$d?min($d):null]);`;
  return files;
}
export function random(seed) {
  let state=seed>>>0;return()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return(state>>>0)/4294967296;};
}
function shuffled(values,rng) {
  const result=[...values];for(let i=result.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[result[i],result[j]]=[result[j],result[i]];}return result;
}
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function benchmarkTrial(host,artifact,{label,rounds=7,warmup=16,seed=1,persist=()=>{}}) {
  const result={label,rounds,warmup,seed,artifactSha256:await sha256(artifact),
    connectionAdmission:typeof host.commonMemoryPrototypeConnect==='function'?'single-worker-turn':'split-rpc',
    samples:[],throughput:[],files:{},passed:false};
  const shared=label==='vm-shared', rng=random(seed), files=benchmarkFiles();
  let launched;
  const publish=()=>persist(result);
  try {
    for(const [name,source] of Object.entries(files)) {
      const bytes=encode(source);result.files[name]={bytes:bytes.length,sha256:await sha256(bytes)};
      await host.writeFileToVfs('/tmp/'+name,bytes);
    }
    await host.writeFileToVfs('/tmp/bench-fpm.wasm',new Uint8Array(artifact),0o755);
    await host.writeFileToVfs('/tmp/bench-fpm.conf',encode('[global]\npid=/tmp/bench-fpm.pid\nerror_log=/tmp/bench-fpm.log\ndaemonize=no\n[probe]\nlisten=127.0.0.1:18973\npm=static\npm.max_children=2\npm.max_requests=0\ncatch_workers_output=yes\nclear_env=no\nchdir=/tmp\n'));
    const started=performance.now();
    launched=await host.spawnFromVfs('/tmp/bench-fpm.wasm',['php-fpm','-n','-F','-y','/tmp/bench-fpm.conf',
      '-d','opcache.enable=1','-d',`opcache.file_cache_only=${shared?0:1}`,'-d',`opcache.file_cache=${shared?'':'/tmp'}`,
      '-d','opcache.memory_consumption=8','-d','opcache.interned_strings_buffer=1','-d','opcache.file_update_protection=0',
      '-d','opcache.validate_timestamps=0','-d','opcache.jit_buffer_size=0'],
      {cwd:'/tmp',env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],uid:1000,gid:1000,stdin:new Uint8Array()});
    result.master=launched.pid;
    launched.exit.then(code=>{result.serverExit=code;publish();},error=>{result.serverExit=String(error);publish();});
    while(!await host.pickListenerTarget(18973)) {
      must(result.serverExit===undefined,`FPM exited ${result.serverExit}`);
      must(performance.now()-started<60000,'FPM startup deadline');
      await new Promise(r=>setTimeout(r,1));
    }
    result.listenerReadyMs=performance.now()-started;publish();
    const expected={empty:0,compute:2088960,includes:2676};
    const request=async (workload,phase,round)=>{
      const response=await fastcgi(host,18973,`/tmp/${workload}.php`);
      must(!response.stderr,`FastCGI stderr: ${response.stderr}`);
      const body=JSON.parse(response.body);
      must(body.checksum===expected[workload] && body.private===1,'workload checksum/private-state failure');
      must(Number.isFinite(body.guest_ms) && body.guest_ms>=0,'invalid guest timer');
      const sample={phase,workload,round,elapsedMs:response.elapsedMs,...body};
      result.samples.push(sample);return sample;
    };
    // First request can include worker compilation/startup beyond listener bind.
    for(const workload of shuffled(['empty','compute','includes'],rng)) {await request(workload,'cold',0);publish();}
    for(let round=0;round<warmup;round++) {
      for(const workload of shuffled(['empty','compute','includes'],rng))
        await Promise.all([request(workload,'warmup',round),request(workload,'warmup',round)]);
      publish();
    }
    must(new Set(result.samples.filter(s=>s.phase==='warmup').map(s=>s.pid)).size===2,'both workers must warm before timing');
    for(let round=0;round<rounds;round++) {
      for(const workload of shuffled(['empty','compute','includes'],rng)) await request(workload,'warm',round);
      for(const workload of shuffled(['compute','includes'],rng)) {
        const started=performance.now();
        const samples=await Promise.all([request(workload,'concurrent',round),request(workload,'concurrent',round)]);
        const elapsedMs=performance.now()-started;
        result.throughput.push({workload,round,requests:2,elapsedMs,requestsPerSecond:2000/elapsedMs,pids:samples.map(s=>s.pid)});
      }
      publish();
    }
    result.workers=[...new Set(result.samples.map(s=>s.pid))];
    must(result.workers.length===2,'both workers must serve timed requests');
    result.meta=JSON.parse((await fastcgi(host,18973,'/tmp/meta.php')).body);
    must(result.meta.file_cache_only===(shared?'0':'1'),'incorrect OPcache mode');
    if(shared) must(result.meta.status?.opcache_enabled===true && result.meta.cache_bins===0,'shared cache control is not shared-only');
    else must(result.meta.status?.opcache_enabled===false && result.meta.status.file_cache_only===true
      && result.meta.cache_bins>0,'file-cache control did not produce cache files');
    result.memory=await host.commonMemoryPrototypeStats();
    must(label==='native-file'?result.memory.roots===0:result.memory.roots===3,'wrong process address model');
    result.kernelPages=await host.getKernelMemoryPages();
    const log=await host.readFileFromVfs('/tmp/bench-fpm.log');result.fpmLog=log?decode(log):null;
    await host.signalProcess(launched.pid,15);result.serverExit=await launched.exit;
    must(result.serverExit===0,'FPM did not exit cleanly');result.passed=true;
  } catch(error) {
    result.error=String(error)+'\n'+String(error.stack||'');
    const log=await host.readFileFromVfs('/tmp/bench-fpm.log').catch(()=>null);result.fpmLog=log?decode(log):null;
  } finally {publish();}
  return result;
}
