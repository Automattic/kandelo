import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {check} from './runner.mjs';
// Compiler protocol checks stay in a disposable Worker and return scalars.
parentPort.postMessage(await check(await readFile(workerData)));
