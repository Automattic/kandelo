import { readFileSync } from 'node:fs';
import { runEpollProbe } from './epoll-core.js';
const bytes = readFileSync('/Users/brandon/kandelo-abi44-reconcile/local-binaries/kernel.wasm');
const r = await runEpollProbe(new Uint8Array(bytes));
console.log(JSON.stringify({ engine: `node ${process.version}`, ...r }, null, 1));
