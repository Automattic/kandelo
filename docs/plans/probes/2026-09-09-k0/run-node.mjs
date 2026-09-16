import { readFile } from 'node:fs/promises';
import { runProbes } from './probe-core.js';
const out = await runProbes(async (f) => new Uint8Array(await readFile(new URL(f, import.meta.url))));
console.log(JSON.stringify({ engine: `node ${process.version}`, results: out }, null, 2));
