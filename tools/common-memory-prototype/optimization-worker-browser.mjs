import { instantiateC } from './optimization-runtime.mjs';
let guest;
self.onmessage = ({ data: { id, action, data } }) => {
  try {
    const value = action === 'init' ? (guest = instantiateC(data.module, data.memory, data.stackTop), true)
      : guest[data.name](...data.args);
    self.postMessage({ id, value });
  } catch (e) { self.postMessage({ id, error: e.stack }); }
};
