import { checks } from './checks.mjs';
import { benchmark } from './benchmark.mjs';
import { endpoint } from './endpoint.mjs';
self.onmessage = async ({ data: { checksOnly } }) => {
  try {
    if (!self.crossOriginIsolated) throw Error('COOP/COEP required');
    const modules = Object.fromEntries(await Promise.all(['native', 'inline', 'helper'].map(async mode => {
      const response = await fetch(`/artifacts/${mode}.wasm`);
      if (!response.ok) throw Error(`artifact HTTP ${response.status}`);
      return [mode, await WebAssembly.compile(await response.arrayBuffer())];
    })));
    const remote = async () => endpoint(new Worker(new URL('./worker-browser.mjs', import.meta.url), { type: 'module' }));
    const result = { userAgent: navigator.userAgent, crossOriginIsolated: self.crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency, time: new Date().toISOString() };
    result.correctness = await checks(modules, remote);
    let refused = false;
    try { await checks(modules, remote, 'share-private'); } catch (e) {
      if (!e.message.includes('parent private bytes independent')) throw e;
      refused = true;
    }
    if (!refused) throw Error('broken fork negative control escaped');
    result.negativeControl = 'broken private-page clone rejected';
    if (!checksOnly) result.benchmark = await benchmark(modules, progress => self.postMessage({ progress }));
    self.postMessage({ result });
  } catch (e) { self.postMessage({ error: e.stack }); }
};
