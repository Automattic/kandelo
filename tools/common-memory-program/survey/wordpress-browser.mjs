import {BrowserKernel} from '/artifacts/browser-kernel-host.mjs';
import {wordpressTrial} from './wordpress-fixture.mjs';
import {describeError} from './describe-error.mjs';
const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
window.runWordPressSurvey=async options=>{
  const result={crossOriginIsolated,stdout:[],stderr:[],diagnostics:[]};
  const host=new BrowserKernel({maxWorkers:24,
    onStdout:data=>result.stdout.push({text:new TextDecoder().decode(data)}),
    onStderr:data=>result.stderr.push({text:new TextDecoder().decode(data)}),
    onHostDiagnostic:e=>result.diagnostics.push(e)});
  try {
    const [kernel,image,artifact,config]=await Promise.all([
      fetch('/kernel.wasm').then(r=>r.arrayBuffer()),fetch('/wordpress.vfs.zst').then(r=>r.arrayBuffer()),
      fetch('/fpm.wasm').then(r=>r.arrayBuffer()),fetch('/config.json').then(r=>r.json())]);
    [result.kernelSha256,result.imageSha256,result.artifactSha256]=await Promise.all([kernel,image,artifact].map(sha));
    await host.initFromImage({kernelWasm:kernel,vfsImage:new Uint8Array(image),lazyUrlBase:location.origin+'/'});
    result.trial=await wordpressTrial(host,artifact,{...options,wpConfig:config.wpConfig,
      persist:trial=>{result.trial=trial;window.surveyProgress=result;}});
  } catch(error) {result.error=describeError(error);}
  finally {try {await host.destroy();result.destroyed=true;}catch(error){result.destroyError=String(error.stack||error);}}
  return result;
};
