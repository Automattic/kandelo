import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { loadavg } from 'node:os';
import { renderWordPressConfig } from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import { wordpressTrial } from './wordpress-fixture.mjs';
import { timestampOptionsFromEnv } from './wordpress-policy.mjs';
import { preloadOptionsFromEnv } from './wordpress-preload-config.mjs';
const [profile,image,artifact,out,label='vm-shared',backend='sqlite']=process.argv.slice(2);
const kernel=process.env.KANDELO_SURVEY_KERNEL??'local-binaries/source-only-v1/kernel.wasm';
mkdirSync(out,{recursive:true});
process.env.WASM_POSIX_RESOLUTION_POLICY='source-only-v1';
process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=resolve('local-binaries/source-only-v1');
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const result:any={runtime:process.version,flags:process.execArgv,profile,imageSha256:sha(image),artifactSha256:sha(artifact),
  kernelSha256:sha(kernel),loadBefore:loadavg(),stdout:[],stderr:[],diagnostics:[]};
const save=()=>writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');
const host=new NodeKernelHost({rootfsImage:readFileSync(image),maxWorkers:24,
  onStdout:(pid:number,data:Uint8Array)=>result.stdout.push({pid,text:new TextDecoder().decode(data)}),
  onStderr:(pid:number,data:Uint8Array)=>result.stderr.push({pid,text:new TextDecoder().decode(data)}),
  onHostDiagnostic:(e:unknown)=>result.diagnostics.push(e)});
const watchdog=setTimeout(()=>{result.timeout=true;save();void host.destroy();},300000);
try {
  await host.init(Uint8Array.from(readFileSync(kernel)).buffer);
  result.trial=await wordpressTrial(host,Uint8Array.from(readFileSync(artifact)).buffer,{
    label,backend,wpConfig:renderWordPressConfig('selectable','/','http'),
    warmup:Number(process.env.KANDELO_SURVEY_WARMUP??4),rounds:Number(process.env.KANDELO_SURVEY_ROUNDS??7),
    seed:Number(process.env.KANDELO_SURVEY_SEED??6197),
    ...timestampOptionsFromEnv(process.env),
    ...preloadOptionsFromEnv(process.env),
    probeRequests:Number(process.env.KANDELO_SURVEY_PROBES??0),persist:(trial:unknown)=>{result.trial=trial;save();},
  });
} catch(error) {result.error=String(error);}
finally {
  try {await host.destroy();result.destroyed=true;} catch(error) {result.destroyError=String(error);}
  clearTimeout(watchdog);result.loadAfter=loadavg();save();
}
if(!result.trial?.passed||!result.destroyed||result.diagnostics.length) {console.error(result.error??result.trial?.error??result.diagnostics);process.exitCode=1;}
else console.log(JSON.stringify({passed:true,label,backend,samples:result.trial.samples.length,memory:result.trial.memory.at(-1)}));
