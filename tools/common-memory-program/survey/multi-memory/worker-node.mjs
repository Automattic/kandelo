import {parentPort,workerData} from 'node:worker_threads';
import {readFileSync} from 'node:fs';
import {runProbe} from './probe.mjs';
try {parentPort.postMessage(runProbe(readFileSync(workerData.path)));}
catch(error){parentPort.postMessage({passed:false,failureKind:'mechanism-error',error:String(error.stack||error)});}
parentPort.close();
