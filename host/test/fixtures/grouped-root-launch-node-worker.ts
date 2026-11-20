import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { NodePlatformIO } from '../../src/platform/node';
import { NodeWorkerAdapter } from '../../src/worker-adapter';
import { execute } from './grouped-root-launch-execution';
try {
    parentPort!.postMessage(await execute({ ...workerData, kernelBytes: Uint8Array.from(readFileSync(workerData.kernel)).buffer, imageBytes: readFileSync(workerData.image), io: new NodePlatformIO(), adapter: new NodeWorkerAdapter(), joins: true }));
}
catch (e) {
    parentPort!.postMessage({ failure: String(e), stack: e instanceof Error ? e.stack : undefined });
}
finally {
    parentPort!.close();
}
