import {parentPort,workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {checkDataInit} from './data-init-runner.mjs';
parentPort.postMessage(await checkDataInit(await readFile(workerData.ordinary),await readFile(workerData.grouped),await readFile(workerData.activeOrdinary),await readFile(workerData.activeGrouped)));
