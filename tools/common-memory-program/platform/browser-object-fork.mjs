import {BrowserKernel} from '/artifacts/browser-kernel-host.mjs';
window.run=async(expectedExit=0)=>{
 const result={crossOriginIsolated,stdout:[],stderr:[],diagnostics:[]};
 const host=new BrowserKernel({maxWorkers:4,
  onStdout:data=>result.stdout.push(new TextDecoder().decode(data)),
  onStderr:data=>result.stderr.push(new TextDecoder().decode(data)),
  onHostDiagnostic:event=>result.diagnostics.push(event)});
 try {
  if(!crossOriginIsolated)throw Error('cross-origin isolation required');
  await host.initFromImage({kernelWasm:await(await fetch('/kernel.wasm')).arrayBuffer(),
   vfsImage:new Uint8Array(await(await fetch('/partial.vfs.zst')).arrayBuffer()),lazyUrlBase:location.origin+'/'});
  const bytes=new Uint8Array(await(await fetch('/php-fpm-vm.wasm')).arrayBuffer());
  await host.writeFileToVfs('/tmp/object-fork.wasm',bytes,0o755);
  const child=await host.spawnFromVfs('/tmp/object-fork.wasm',['object-fork'],
   {cwd:'/tmp',env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],uid:1000,gid:1000,stdin:new Uint8Array()});
  result.exit=await child.exit;
  const passed=result.stdout.join('').includes('PASS real fork: guarded object callees');
  if(result.exit!==expectedExit||passed!==(expectedExit===0)||result.stderr.length||result.diagnostics.length)
   throw Error('real object fork result/diagnostics mismatch');
  result.passed=true;
 }catch(error){result.error=String(error)+'\n'+String(error.stack||'');}
 finally{await host.destroy();result.destroyed=true;}
 return result;
};
