import {BrowserKernel} from '/artifacts/browser-kernel-host.mjs';
import {wordpressTrial} from '/wordpress-fixture.mjs';
import {fileCacheInventory} from '/impact-shared.mjs';
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
function resolution(){let last=performance.now(),minimum=Infinity;for(let i=0;i<100000;i++){const n=performance.now();if(n>last)minimum=Math.min(minimum,n-last);last=n;}return Number.isFinite(minimum)?minimum:null;}
window.runImpact=async options=>{
  const result={crossOriginIsolated,timerResolutionMs:resolution(),stdout:[],stderr:[],diagnostics:[],resources:[]};
  const host=new BrowserKernel({maxWorkers:24,onStdout:b=>result.stdout.push(new TextDecoder().decode(b)),
    onStderr:b=>result.stderr.push(new TextDecoder().decode(b)),onHostDiagnostic:e=>result.diagnostics.push(e)});
  const capture=async phase=>{
    const sample={phase,timeMs:performance.now(),inspection:await host.inspectProcesses(),kernelLinearBytes:(await host.getKernelMemoryPages())*65536};
    if(options.mode==='resource')sample.os=await window.impactFootprint(phase);
    result.resources.push(sample);return sample;
  };
  const stats=host.commonMemoryPrototypeStats.bind(host);
  if(options.mode!=='timing')host.commonMemoryPrototypeStats=async()=>{const value=await stats();await capture('round-'+result.resources.length);return value;};
  try{
    const [kernel,image,artifact,config]=await Promise.all([fetch('/kernel.wasm').then(r=>r.arrayBuffer()),fetch('/wordpress.vfs.zst').then(r=>r.arrayBuffer()),fetch('/fpm.wasm').then(r=>r.arrayBuffer()),fetch('/config.json').then(r=>r.json())]);
    result.identities={kernel:await sha(kernel),image:await sha(image),artifact:await sha(artifact)};
    await host.initFromImage({kernelWasm:kernel,vfsImage:new Uint8Array(image),lazyUrlBase:location.origin+'/'});
    if(options.mode==='resource')result.beforeTrialFootprint=await window.impactFootprint('after-init');
    result.trial=await wordpressTrial(host,artifact,{...options,wpConfig:config.wpConfig,validateTimestamps:true,
      checkTimestampPolicy:options.mode==='check',warmup:options.mode==='check'?0:4,rounds:options.mode==='check'?1:options.mode==='resource'?3:7,
      persist:trial=>{result.trial=trial;window.impactProgress=result;}});
    for(let i=0;i<result.resources.length;i++)result.resources[i].phase=result.trial.memory[i].phase;
    if(!result.trial.passed)throw Error(result.trial.error??'trial failed');
    if(!/^opcache.validate_timestamps=1$/m.test(result.trial.phpIni)||!/^opcache.revalidate_freq=0$/m.test(result.trial.phpIni))throw Error('timestamp configuration drift');
    if(options.mode!=='timing'){
      result.fileCache=await fileCacheInventory(host);
      if(options.label==='vm-shared'?result.fileCache.files!==0:result.fileCache.files<100)throw Error('unexpected OPcache FILE corpus');
    }
    result.passed=true;
  }catch(error){result.error=String(error?.stack??error);}
  finally{try{await host.destroy();result.destroyed=true;}catch(error){result.destroyError=String(error);}}
  if(options.mode==='resource')result.afterDestroyFootprint=await window.impactFootprint('after-destroy');
  return result;
};
