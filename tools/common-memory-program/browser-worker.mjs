import { runAtomicFusion } from './survey/atomic-fusion-checks.mjs';
import { runRegional } from './survey/regional-checks.mjs';
import { runCanary } from './checks.mjs';
import { runAccessForms } from './access-checks.mjs';
import { runCacheCoherency } from './survey/cache-checks.mjs';
import { runBounds } from './survey/bounds-checks.mjs';
import { runObjectRegions } from './survey/object-checks.mjs';
self.onmessage = async ({data}) => {
  try {
    const bytes = await (await fetch('/artifacts/canary-vm.wasm')).arrayBuffer();
    const module = await WebAssembly.compile(bytes);
    const access=await WebAssembly.compile(await(await fetch('/artifacts/access-vm.wasm')).arrayBuffer());
    const bounds=data.bounds?runBounds(await WebAssembly.compile(await(await fetch('/artifacts/bounds-vm.wasm')).arrayBuffer())):undefined;
    const atomics=data.atomics?runAtomicFusion(await WebAssembly.compile(await(await fetch('/artifacts/atomic-vm.wasm')).arrayBuffer()),await WebAssembly.compile(await(await fetch('/artifacts/atomic-native.wasm')).arrayBuffer())):undefined;
    const regional=data.regional?runRegional(await WebAssembly.compile(await(await fetch('/artifacts/regional-vm.wasm')).arrayBuffer()),{guardCounters:data.regionalDiagnostics}):undefined;
    const objects=data.objects?runObjectRegions(
      await WebAssembly.compile(await(await fetch('/artifacts/objects-vm.wasm')).arrayBuffer()),
      await WebAssembly.compile(await(await fetch('/artifacts/object-helper.wasm')).arrayBuffer())):undefined;
    self.postMessage({ result: {...runCanary(module),accessForms:runAccessForms(access),coherency:runCacheCoherency(module,access),bounds,objects,atomics,regional} });
  } catch (error) { self.postMessage({ error: String(error.stack || error) }); }
};
