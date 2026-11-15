import {BrowserKernel} from '/artifacts/browser-kernel-host.mjs';
import {fastcgi} from './fastcgi.mjs';
import {checkOpcache} from './check-opcache.mjs';
const encode=s=>new TextEncoder().encode(s), decode=b=>new TextDecoder().decode(b);
const must=(condition,message)=>{if(!condition) throw Error(message);};
window.run=async (mode='shared')=>{
  must(crossOriginIsolated,'cross-origin isolation is required');
  const result={mode,crossOriginIsolated,stdout:[],stderr:[],diagnostics:[],processEvents:[],requests:[]};
  const host=new BrowserKernel({maxWorkers:6,
    onStdout:(pid,data)=>result.stdout.push({pid,text:decode(data)}),
    onStderr:(pid,data)=>result.stderr.push({pid,text:decode(data)}),
    onHostDiagnostic:event=>result.diagnostics.push(event),
    onProcessEvent:event=>result.processEvents.push(event),
  });
  const bytes=await (await fetch('/php-fpm-vm.wasm')).arrayBuffer();
  const shared=mode==='shared';
  try {
    await host.initFromImage({kernelWasm:await (await fetch('/kernel.wasm')).arrayBuffer(),
      vfsImage:new Uint8Array(await (await fetch('/partial.vfs.zst')).arrayBuffer()),lazyUrlBase:location.origin+'/'});
    await host.writeFileToVfs('/tmp/vm-fpm.wasm',new Uint8Array(bytes),0o755);
    await host.writeFileToVfs('/tmp/vm-fpm.conf',encode('[global]\npid=/tmp/vm-fpm.pid\nerror_log=/tmp/vm-fpm.log\ndaemonize=no\n[probe]\nlisten=127.0.0.1:18973\npm=static\npm.max_children=2\npm.max_requests=0\ncatch_workers_output=yes\nclear_env=no\nchdir=/tmp\n'));
    await host.writeFileToVfs('/tmp/vm-probe.php',encode('<?php usleep(20000); $local=($local??0)+1; echo json_encode(["pid"=>getmypid(),"private"=>$local,"answer"=>array_sum(range(1,1000)),"file_cache_only"=>ini_get("opcache.file_cache_only"),"opcache"=>opcache_get_status(false)]);'));
    const launched=await host.spawnFromVfs('/tmp/vm-fpm.wasm',['php-fpm','-n','-F','-y','/tmp/vm-fpm.conf',
      '-d','opcache.enable=1','-d',`opcache.file_cache_only=${shared?0:1}`,'-d',`opcache.file_cache=${shared?'':'/tmp'}`,
      '-d','opcache.memory_consumption=8','-d','opcache.interned_strings_buffer=1','-d','opcache.file_update_protection=0',
      '-d','opcache.validate_timestamps=0','-d','opcache.jit_buffer_size=0'],
      {cwd:'/tmp',env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],uid:1000,gid:1000,stdin:new Uint8Array()});
    result.master=launched.pid;
    launched.exit.then(code=>{result.serverExit=code;},error=>{result.serverExit=String(error);});
    const deadline=performance.now()+60000;
    while(!await host.pickListenerTarget(18973)) {
      must(result.serverExit===undefined,`FPM exited ${result.serverExit}`);
      must(performance.now()<deadline,'FPM listener deadline');
      await new Promise(r=>setTimeout(r,10));
    }
    result.requests=await Promise.all(Array.from({length:4},()=>fastcgi(host,18973,'/tmp/vm-probe.php')));
    for(const response of result.requests) {
      response.json=JSON.parse(response.body);
      must(response.json.answer===500500 && response.json.private===1,'incorrect request result');
      must(response.json.file_cache_only===(shared?'0':'1'),'wrong cache mode');
      if(shared) must(response.json.opcache.opcache_enabled,'OPcache is disabled');
    }
    if(shared) {
      await checkOpcache(host,18973,result.processEvents,evidence=>{result.opcacheChecks=evidence;});
      must(new Set(result.opcacheChecks.requests.map(r=>r.json.pid)).size>=2,'both FPM workers must serve requests');
    } else must(new Set(result.requests.map(r=>r.json.pid)).size===2,'both FPM workers must serve requests');
    const log=await host.readFileFromVfs('/tmp/vm-fpm.log');result.fpmLog=log?decode(log):null;
    await host.signalProcess(launched.pid,15);result.serverExit=await launched.exit;
    must(result.serverExit===0,'FPM master did not exit cleanly');
    must(!result.stderr.length && !result.diagnostics.length,'unexpected guest or host errors');
    result.passed=true;
  } catch(error) {
    result.error=String(error)+'\n'+String(error.stack||'');
    const log=await host.readFileFromVfs('/tmp/vm-fpm.log').catch(()=>null);result.fpmLog=log?decode(log):null;
  }
  finally {
    try {await host.destroy();result.destroyed=true;} catch(error){result.destroyError=String(error.stack||error);result.passed=false;}
  }
  return result;
};
