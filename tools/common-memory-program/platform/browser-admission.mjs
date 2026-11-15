import {BrowserKernel} from '/artifacts/browser-kernel-host.mjs';
window.run=async(mode)=>{
 const result={mode,crossOriginIsolated,stdout:[],stderr:[],diagnostics:[]};
 const host=new BrowserKernel({maxWorkers:4,
  onStdout:b=>result.stdout.push(new TextDecoder().decode(b)),
  onStderr:b=>result.stderr.push(new TextDecoder().decode(b)),
  onHostDiagnostic:e=>result.diagnostics.push(e)});
 try {
  if(!crossOriginIsolated)throw Error('cross-origin isolation required');
  await host.initFromImage({kernelWasm:await(await fetch(mode==='old-kernel'?'/old-kernel.wasm':'/kernel.wasm')).arrayBuffer(),
   vfsImage:new Uint8Array(await(await fetch('/partial.vfs.zst')).arrayBuffer()),lazyUrlBase:location.origin+'/'});
  const program=mode==='ordinary'?'/ordinary.wasm':'/grouped.wasm';
  await host.writeFileToVfs('/tmp/admission.wasm',new Uint8Array(await(await fetch(program)).arrayBuffer()),0o755);
  try {
   const child=await host.spawnFromVfs('/tmp/admission.wasm',['admission',mode==='ordinary'?'ordinary':'grouped'],
    {cwd:'/tmp',env:['PATH=/usr/bin:/bin','HOME=/home/maker','TMPDIR=/tmp'],uid:1000,gid:1000,stdin:new Uint8Array()});
   result.exit=await child.exit;
  }catch(error){result.spawnError=String(error);}
  if(mode==='old-kernel') {
   if(!result.spawnError?.includes('Kernel lacks shared-group memory admission')||result.stdout.length)
    throw Error('old kernel must refuse before guest execution');
  }else if(result.spawnError||result.exit!==0||!result.stdout.join('').includes('PASS '+(mode==='ordinary'?'ordinary control':'grouped admission'))||result.stderr.length||result.diagnostics.length)
   throw Error('admission/control result mismatch');
  result.passed=true;
 }catch(error){result.error=String(error.stack||error);}
 finally{await host.destroy();result.destroyed=true;}
 return result;
};
