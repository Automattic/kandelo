import {BrowserKernel} from '/artifacts/browser-kernel-host.mjs';
window.run=async control=>{
 const result={control,crossOriginIsolated,stdout:'',stderr:'',diagnostics:[],passed:false};
 const host=new BrowserKernel({maxWorkers:4,
  onStdout:data=>result.stdout+=new TextDecoder().decode(data),
  onStderr:data=>result.stderr+=new TextDecoder().decode(data),
  onHostDiagnostic:event=>result.diagnostics.push(event)});
 try {
  if(!crossOriginIsolated)throw Error('cross-origin isolation required');
  await host.initFromImage({kernelWasm:await(await fetch('/kernel.wasm')).arrayBuffer(),
   vfsImage:new Uint8Array(await(await fetch('/partial.vfs.zst')).arrayBuffer()),lazyUrlBase:location.origin+'/'});
  const bytes=new Uint8Array(await(await fetch('/php-fpm-vm.wasm')).arrayBuffer());
  result.artifactSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  await host.writeFileToVfs('/tmp/lto-fork.wasm',bytes,0o755);
  const child=await host.spawnFromVfs('/tmp/lto-fork.wasm',['lto-fork','fork',control.shared?'shared':'private'],
   {cwd:'/tmp',env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],uid:1000,gid:1000,stdin:new Uint8Array()});
  result.exit=await child.exit;result.memory=await host.commonMemoryPrototypeStats();
  // Stats describe current entries after child reaping/exit teardown, not
  // historical fork roots. Retain them without asserting a lifecycle race.
  if(result.exit!==control.expectedExit||result.stdout.includes('PASS LTO fork:')!==(control.expectedExit===0)||
     result.stderr||result.diagnostics.length)
   throw Error('LTO real fork result/diagnostics mismatch');
  result.passed=true;
 }catch(error){result.error=String(error)+'\n'+String(error.stack||'');}
 finally{await host.destroy();result.destroyed=true;}
 return result;
};
