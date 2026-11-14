import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { checks } from './checks.mjs';
import { benchmark } from './benchmark.mjs';
import { endpoint } from './endpoint.mjs';

const dir = resolve(process.argv[2]);
const modules = Object.fromEntries(await Promise.all(['native', 'inline', 'helper'].map(async mode =>
  [mode, await WebAssembly.compile(await readFile(`${dir}/${mode}.wasm`))])));
const remote = async () => endpoint(new Worker(new URL('./worker-node.mjs', import.meta.url)), true);
const host = () => ({ time: new Date().toISOString(), load: os.loadavg(), freeMemory: os.freemem() });
const result = { host: { node: process.version, versions: process.versions, platform: os.platform(), arch: os.arch(),
  cpu: os.cpus()[0].model, logicalCpus: os.availableParallelism(), totalMemory: os.totalmem() }, before: host() };
result.correctness = await checks(modules, remote);
let refused = false;
try { await checks(modules, remote, 'share-private'); } catch (e) {
  if (!e.message.includes('parent private bytes independent')) throw e;
  refused = true;
}
if (!refused) throw Error('broken fork negative control escaped');
result.negativeControl = 'deliberately sharing private pages fails the independent parent check';
console.log('correctness passed', result.correctness.passed);
if (!process.argv.includes('--checks-only')) {
  result.benchmark = await benchmark(modules, x => console.log('case', JSON.stringify(x)));
}
result.after = host();
await mkdir(dir, { recursive: true });
await writeFile(`${dir}/node.json`, JSON.stringify(result, null, 2) + '\n');
console.log(`wrote ${dir}/node.json`);
