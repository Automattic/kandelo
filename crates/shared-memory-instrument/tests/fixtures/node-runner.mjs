import {Worker,parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {check} from './runner.mjs';
function spawnPeer(request) {
  const worker=new Worker(new URL('./pool-peer-node.mjs',import.meta.url),{workerData:request,execArgv:['--import','tsx']});
  let readyResolve,readyReject,doneResolve,doneReject;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const done=new Promise((resolve,reject)=>{doneResolve=resolve;doneReject=reject;});
  ready.catch(()=>{});done.catch(()=>{});
  worker.on('message',message=>{if(message.ready)readyResolve();else if(message.result)doneResolve(message.result);});
  worker.on('error',error=>{readyReject(error);doneReject(error);});
  worker.on('exit',code=>{if(code!==0){const error=Error('Peer exited '+code);readyReject(error);doneReject(error);}});
  return {ready,done,stop:()=>worker.terminate()};
}
parentPort.postMessage(await check(await readFile(workerData),spawnPeer));
