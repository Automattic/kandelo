import {parentPort,workerData} from 'node:worker_threads';
import {runPeer} from './pool-peer.mjs';
parentPort.postMessage({result:await runPeer(workerData,()=>parentPort.postMessage({ready:true}))});
