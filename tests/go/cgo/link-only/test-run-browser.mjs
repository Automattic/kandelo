import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from '../../../../apps/browser-demos/node_modules/playwright/index.mjs';

const [wasmPath, sectionsPath] = process.argv.slice(2);
const wasmBytes = readFileSync(wasmPath);
const sections = readFileSync(sectionsPath, 'utf8');
const indices = {};

for (const name of ['c_target', 'weighted', 'cross_weighted', 'tls_weighted', 'call_function_pointer']) {
  const match = sections.match(new RegExp(`elem\\[(\\d+)\\] = ref\\.func:\\d+ <${name}>`));
  assert.ok(match, `missing table entry for ${name}`);
  indices[name] = Number(match[1]);
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const isolationHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };
  await page.route('http://localhost:37777/**', async (route) => {
    if (route.request().url().endsWith('.wasm')) {
      await route.fulfill({ body: wasmBytes, contentType: 'application/wasm', headers: isolationHeaders });
    } else {
      await route.fulfill({ body: '<!doctype html>', contentType: 'text/html', headers: isolationHeaders });
    }
  });
  await page.goto('http://localhost:37777/');
  const result = await page.evaluate(async (tableIndices) => {
    if (!crossOriginIsolated) {
      throw new Error('browser page is not cross-origin isolated');
    }
    const moduleBytes = await (await fetch('/combined.wasm')).arrayBuffer();
    const module = await WebAssembly.compile(moduleBytes);
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    const imports = { env: { memory } };
    for (const entry of WebAssembly.Module.imports(module)) {
      if (entry.kind === 'function') {
        imports[entry.module] ??= {};
        imports[entry.module][entry.name] = () => 0;
      }
    }
    const instance = await WebAssembly.instantiate(module, imports);
    const table = instance.exports.__indirect_function_table;
    instance.exports.__wasm_init_tls(0x300000);
    const firstTLS = table.get(tableIndices.tls_weighted)(5);
    const secondTLS = table.get(tableIndices.tls_weighted)(5);
    const secondInstance = await WebAssembly.instantiate(module, imports);
    secondInstance.exports.__wasm_init_tls(0x310000);
    const isolatedTLS = secondInstance.exports.__indirect_function_table.get(tableIndices.tls_weighted)(5);
    const retainedTLS = table.get(tableIndices.tls_weighted)(5);
    return [table.get(tableIndices.c_target)(5), table.get(tableIndices.weighted)(5), table.get(tableIndices.cross_weighted)(5), table.get(tableIndices.call_function_pointer)(5), firstTLS, secondTLS, isolatedTLS, retainedTLS];
  }, indices);
  assert.deepEqual(result, [10, 12, 13, 8, 12, 13, 12, 14]);
  console.log('Chromium executes Go-linked C functions with initialized data and per-instance TLS');
} finally {
  await browser.close();
}
