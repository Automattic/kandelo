// Real WordPress training, separate from all unprofiled timing runs.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {renderWordPressConfig} from '../../../apps/browser-demos/lib/init/wordpress-runtime-config';
import {wordpressTrial} from './wordpress-fixture.mjs';
const [profile,image,artifact,out,label='vm-shared',backend='sqlite']=process.argv.slice(2);
if(existsSync(out))throw Error('choose a fresh output directory');mkdirSync(out,{recursive:true});
process.env.WASM_POSIX_RESOLUTION_POLICY='source-only-v1';
process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=resolve('local-binaries/source-only-v1');
const sha=(p:string)=>createHash('sha256').update(readFileSync(p)).digest('hex');
const result:any={scope:'Node real WordPress PGO training, not performance evidence',label,backend,runtime:process.version,flags:process.execArgv,
 imageSha256:sha(image),artifactSha256:sha(artifact),kernelSha256:sha('local-binaries/source-only-v1/kernel.wasm'),
 stdout:[],stderr:[],diagnostics:[],events:[],profiles:[],profilePattern:'/tmp/wordpress-training-%m.profraw',
 trainingCorpus:['home','article','authenticated-admin','REST-posts','login','cache-status'],
 heldOutPerformanceClaim:false};
const {NodeKernelHost}=await import(pathToFileURL(resolve(profile,'node-kernel-host.mjs')));
const exitWaiters=new Map<number,(e:any)=>void>();
const host=new NodeKernelHost({rootfsImage:readFileSync(image),maxWorkers:24,
 onStdout:(pid:number,b:Uint8Array)=>result.stdout.push({pid,text:new TextDecoder().decode(b)}),
 onStderr:(pid:number,b:Uint8Array)=>result.stderr.push({pid,text:new TextDecoder().decode(b)}),
 onHostDiagnostic:(e:any)=>result.diagnostics.push(e),
 onProcessEvent:(e:any)=>{result.events.push(e);if(e.kind==='exit'){exitWaiters.get(e.pid)?.(e);exitWaiters.delete(e.pid);}}});
const save=()=>writeFileSync(resolve(out,'result.json'),JSON.stringify(result,null,2)+'\n');
save();
const watchdog=setTimeout(()=>{result.timeout=true;save();void host.destroy();},600000);
const encode=(s:string)=>new TextEncoder().encode(s),decode=(b:Uint8Array)=>new TextDecoder().decode(b);
const exited=(pid:number)=>{
 const e=result.events.find((e:any)=>e.kind==='exit'&&e.pid===pid);
 return e?Promise.resolve(e):new Promise<any>(r=>exitWaiters.set(pid,r));
};
try {
 await host.init(Uint8Array.from(readFileSync('local-binaries/source-only-v1/kernel.wasm')).buffer);
 const env=decode(await host.readFileFromVfs('/etc/dinit.d/env'));
 assert.ok(!env.includes('LLVM_PROFILE_FILE'));
 await host.writeFileToVfs('/etc/dinit.d/env',encode(env+'\nLLVM_PROFILE_FILE='+result.profilePattern+'\n'));
 const conf=decode(await host.readFileFromVfs('/etc/php-fpm.conf'));
 assert.equal((conf.match(/^\[global\]$/gm)??[]).length,1);
 assert.ok(!/^\s*(process_control_timeout|pid)\s*=/m.test(conf));
 result.fpmConf=conf.replace('[global]','[global]\nprocess_control_timeout = 30s\npid = /tmp/wordpress-training-fpm.pid');
 await host.writeFileToVfs('/etc/php-fpm.conf',encode(result.fpmConf));
 result.trial=await wordpressTrial(host,Uint8Array.from(readFileSync(artifact)).buffer,{
  label,backend,wpConfig:renderWordPressConfig('selectable','/','http'),warmup:1,rounds:1,seed:7391,
  persist:(t:any)=>{result.trial=t;save();}});
 assert.equal(result.trial.passed,true,result.trial.error);
 result.master=Number(decode(await host.readFileFromVfs('/tmp/wordpress-training-fpm.pid')).trim());
 assert.ok(Number.isSafeInteger(result.master)&&result.master>0);
 result.workers=[...new Set(result.trial.statuses.map((s:any)=>s.pid))];assert.equal(result.workers.length,2);
 const waits=[result.master,...result.workers].map(exited);
 result.quitSignal=3;await host.signalProcess(result.master,result.quitSignal);
 result.exits=await Promise.all(waits);for(const e of result.exits)assert.equal(e.exitStatus,0);
 for(const e of await host.readDirFromVfs('/tmp'))if(e.name.startsWith('wordpress-training-')&&e.name.endsWith('.profraw')) {
  const b=await host.readFileFromVfs('/tmp/'+e.name);assert.ok(b?.length);writeFileSync(resolve(out,e.name),b);
  result.profiles.push({name:e.name,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});
 }
 assert.ok(result.profiles.length);assert.deepEqual(result.diagnostics,[]);assert.ok(!result.timeout);result.passed=true;
}catch(error:any){result.error=String(error.stack||error);}
finally {
 clearTimeout(watchdog);
 try {result.fpmLog=decode(await host.readFileFromVfs('/var/log/php-fpm.log'));}catch(error){result.logReadError=String(error);}
 await host.destroy();result.destroyed=true;save();
}
console.log(JSON.stringify({passed:result.passed,error:result.error,backend,label,profiles:result.profiles,exits:result.exits}));
if(!result.passed)throw Error('WordPress PGO training/flush failed');
