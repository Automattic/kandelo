import { parentPort } from 'node:worker_threads';
import { instantiateRemote } from './runtime.mjs';
let guest;
parentPort.on('message', ({ id, action, data }) => {
  try {
    const value = action === 'init' ? (guest = instantiateRemote(data), true) : guest[data.name](...data.args);
    parentPort.postMessage({ id, value });
  } catch (e) { parentPort.postMessage({ id, error: e.stack }); }
});
