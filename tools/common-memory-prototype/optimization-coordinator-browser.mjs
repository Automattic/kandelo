import { loadOptimizationModules } from './optimization-load.mjs';
import { optimizationChecks } from './optimization-checks.mjs';
import { optimizationBenchmark } from './optimization-benchmark.mjs';
import { endpoint } from './endpoint.mjs';
self.onmessage = async ({ data: { checksOnly } }) => {
  try {
    if (!self.crossOriginIsolated) throw Error('COOP/COEP required');
    const modules = await loadOptimizationModules(async name => {
      const response = await fetch(`/artifacts/${name}`);
      if (!response.ok) throw Error(`HTTP ${response.status}: ${name}`);
      return response.arrayBuffer();
    });
    const remote = async () => endpoint(new Worker(new URL('./optimization-worker-browser.mjs', import.meta.url), { type: 'module' }));
    const result = { userAgent: navigator.userAgent, time: new Date().toISOString(), crossOriginIsolated: true };
    result.correctness = await optimizationChecks(modules, remote);
    if (!checksOnly) result.benchmark = await optimizationBenchmark(modules, progress => self.postMessage({ progress }));
    self.postMessage({ result });
  } catch (e) { self.postMessage({ error: e.stack }); }
};
