import { runBreadthProbe } from './cross-host-probe.mjs';
try {
  const read = async name => {
    const response = await fetch('/artifacts/' + name);
    if (!response.ok) throw Error('HTTP ' + response.status + ': ' + name);
    return response.arrayBuffer();
  };
  const [single, dual, translated] = await Promise.all(['single.wasm', 'dual.wasm', 'single-vm.wasm'].map(read));
  postMessage(runBreadthProbe({ single, dual, translated }));
} catch (error) { postMessage({ passed: false, error: String(error.stack || error) }); }
close();
