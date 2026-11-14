import {Worker} from 'node:worker_threads';
import {writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadavg} from 'node:os';
const [root,out]=process.argv.slice(2).map(p=>resolve(p));if(existsSync(out))throw Error('fresh output required');const before=loadavg();
const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{root}});
const timeout=setTimeout(()=>{void worker.terminate();},30000);let result;
try{result=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code)reject(Error('worker exit '+code));});});}
finally{clearTimeout(timeout);await worker.terminate();}
writeFileSync(out,JSON.stringify({runtime:process.version,loadBefore:before,loadAfter:loadavg(),...result},null,2)+'\n');console.log(JSON.stringify({passed:result.passed,samples:result.samples.length,output:out}));
