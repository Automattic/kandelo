import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {benchmarkTrial} from './benchmark-fixture.mjs';
import {loadavg,cpus,totalmem} from 'node:os';
const [profile,nativeFile,virtualFile,out,label='vm-shared']=process.argv.slice(2);
mkdirSync(out,{recursive:true});
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')).href);
const result={runtime:process.version,flags:process.execArgv,label,stdout:[],stderr:[],diagnostics:[],events:[],loadBefore:loadavg(),cpus:cpus().length,totalMemory:totalmem()};
const host=new NodeKernelHost({rootfsImage:readFileSync('local-binaries/partial/shell-partial.vfs.zst'),maxWorkers:6,
  onStdout:(pid,data)=>result.stdout.push({pid,text:new TextDecoder().decode(data)}),
  onStderr:(pid,data)=>result.stderr.push({pid,text:new TextDecoder().decode(data)}),
  onHostDiagnostic:event=>result.diagnostics.push(event),onProcessEvent:event=>result.events.push({...event,t:performance.now()}),
});
const save=()=>writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');
const timeout=setTimeout(()=>{result.timeout=true;save();void host.destroy();},240000);
try {
  const started=performance.now();await host.init();result.initMs=performance.now()-started;
  const bytes=readFileSync(label==='native-file'?nativeFile:virtualFile);
  result.trial=await benchmarkTrial(host,bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),
    {label,rounds:Number(process.env.KANDELO_BENCH_ROUNDS??7),warmup:Number(process.env.KANDELO_BENCH_WARMUP??16),seed:Number(process.env.KANDELO_BENCH_SEED??1),persist:trial=>{result.trial=trial;save();}});
} catch(error) {result.error=String(error.stack||error);}
finally {await host.destroy();result.destroyed=true;result.loadAfter=loadavg();clearTimeout(timeout);save();}
if(!result.trial?.passed || result.stderr.length || result.diagnostics.length) {console.error(JSON.stringify({error:result.error??result.trial?.error,label,output:resolve(out,'result.json')}));process.exitCode=1;}
else console.log(JSON.stringify({label,passed:true,memory:result.trial.memory}));
