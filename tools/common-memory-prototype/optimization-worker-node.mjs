import { parentPort } from 'node:worker_threads';
import { instantiateC } from './optimization-runtime.mjs';
let guest;
parentPort.on('message', ({ id, action, data }) => {
  try {
    const value = action === 'init' ? (guest = instantiateC(data.module, data.memory, data.stackTop), true)
      : guest[data.name](...data.args);
    parentPort.postMessage({ id, value });
  } catch (e) { parentPort.postMessage({ id, error: e.stack }); }
});
