import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCanary } from './checks.mjs';
const out = resolve(process.argv[2]);
const module = new WebAssembly.Module(readFileSync(resolve(out, 'canary-vm.wasm')));
const result = runCanary(module);
writeFileSync(resolve(out, 'canary-result.json'), JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
