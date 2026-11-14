import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { loadOptimizationModules } from './optimization-load.mjs';
import { optimizationChecks } from './optimization-checks.mjs';
import { endpoint } from './endpoint.mjs';
import { optimizationBenchmark } from './optimization-benchmark.mjs';
const dir = resolve(process.argv[2]);
const modules = await loadOptimizationModules(name => readFile(`${dir}/${name}`));
const remote = async () => endpoint(new Worker(new URL('./optimization-worker-node.mjs', import.meta.url)), true);
const result = { host: { node: process.version, versions: process.versions, cpu: os.cpus()[0].model,
  platform: os.platform(), arch: os.arch(), logicalCpus: os.availableParallelism() },
  before: { time: new Date().toISOString(), load: os.loadavg(), freeMemory: os.freemem() } };
result.correctness = await optimizationChecks(modules, remote);
console.log('C optimization checks passed', result.correctness.oracleOperations, result.correctness.scalarGroups.length);
if (process.argv.includes('--bench') || process.argv.includes('--smoke')) {
  result.benchmark = await optimizationBenchmark(modules, event => console.log('progress', JSON.stringify({ ...event, load: os.loadavg() })),
    process.argv.includes('--smoke') ? { caseLimit: 2, rounds: 2 } : {});
}
result.after = { time: new Date().toISOString(), load: os.loadavg(), freeMemory: os.freemem() };
const cohort = process.argv.includes('--cohort') ? process.argv[process.argv.indexOf('--cohort') + 1] : 'checks';
await writeFile(`${dir}/optimization-node-${cohort}.json`, JSON.stringify(result, null, 2) + '\n');
