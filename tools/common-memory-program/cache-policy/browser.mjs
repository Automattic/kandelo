import {BrowserKernel} from '/artifacts/browser-kernel-host.mjs';
import {wordpressTrial} from '/cache-policy/wordpress-fixture.mjs';
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
window.runSeed=async backend=>{
 const result={crossOriginIsolated,diagnostics:[],stderr:[],passed:false};
 const host=new BrowserKernel({maxWorkers:24,onHostDiagnostic:e=>result.diagnostics.push(e),onStderr:b=>result.stderr.push(new TextDecoder().decode(b))});
 try{
  const [kernel,image,fpm,config]=await Promise.all([
   fetch('/kernel.wasm').then(r=>r.arrayBuffer()),fetch('/wordpress.vfs.zst').then(r=>r.arrayBuffer()),
   fetch('/fpm.wasm').then(r=>r.arrayBuffer()),fetch('/config.json').then(r=>r.json())]);
  result.identities={kernel:await sha(kernel),image:await sha(image),fpm:await sha(fpm)};
  await host.initFromImage({kernelWasm:kernel,vfsImage:new Uint8Array(image),lazyUrlBase:location.origin+'/'});
  result.trial=await wordpressTrial(host,fpm,{backend,label:'vm-shared',wpConfig:config.wpConfig,
   sharedFileCache:'/var/cache/opcache',diagnosticLog:true,checkTimestampPolicy:true,checkSeededCore:true,validateTimestamps:true,warmup:0,rounds:1,
   persist:trial=>{result.trial=trial;window.seedProgress=result;}});
  if(!result.trial.passed)throw Error(result.trial.error??'WordPress failure');
  const log=result.trial.logs?.['/tmp/seed-opcache.log']??'';
  result.loadedScripts=[...log.matchAll(/File cached script loaded into memory '([^']+)'/g)].map(m=>m[1]);
  if(result.loadedScripts.length<100)throw Error('seed was not loaded into shared WordPress cache');
  if(result.diagnostics.length)throw Error('host diagnostic');result.passed=true;
 }catch(error){result.error=String(error?.stack??error);}
 finally{await host.destroy();result.destroyed=true;}
 return result;
};
