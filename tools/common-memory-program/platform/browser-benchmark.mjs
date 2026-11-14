import {BrowserKernel} from '/artifacts/browser-kernel-host.mjs';
import {benchmarkTrial} from './benchmark-fixture.mjs';
window.runBenchmark=async (label,options={})=>{
  const result={label,crossOriginIsolated,stdout:[],stderr:[],diagnostics:[],events:[]};
  const decode=bytes=>new TextDecoder().decode(bytes);
  const host=new BrowserKernel({maxWorkers:6,
    onStdout:(pid,data)=>result.stdout.push({pid,text:decode(data)}),
    onStderr:(pid,data)=>result.stderr.push({pid,text:decode(data)}),
    onHostDiagnostic:event=>result.diagnostics.push(event),onProcessEvent:event=>result.events.push({...event,t:performance.now()}),
  });
  const artifact=await(await fetch(label==='native-file'?'/php-fpm-native.wasm':'/php-fpm-vm.wasm')).arrayBuffer();
  const kernelWasm=await(await fetch('/kernel.wasm')).arrayBuffer();
  const image=new Uint8Array(await(await fetch('/partial.vfs.zst')).arrayBuffer());
  try {
    const started=performance.now();await host.initFromImage({kernelWasm,vfsImage:image,lazyUrlBase:location.origin+'/'});
    result.initMs=performance.now()-started;
    result.trial=await benchmarkTrial(host,artifact,{label,...options,persist:trial=>{result.trial=trial;window.benchmarkProgress=result;}});
  } catch(error) {result.error=String(error)+'\n'+String(error.stack||'');}
  finally {
    try {await host.destroy();result.destroyed=true;}
    catch(error){result.destroyError=String(error.stack||error);}
  }
  return result;
};
