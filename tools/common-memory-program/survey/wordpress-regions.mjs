import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { regionDelta } from './region-counts.mjs';
const [profile,,, out] = process.argv.slice(2);
if (existsSync(out)) throw Error('choose fresh region-count output');
mkdirSync(out, { recursive: true });
const { NodeKernelHost } = await import(pathToFileURL(resolve(profile, 'node-kernel-host.mjs')).href);
if (typeof NodeKernelHost.prototype.commonMemoryPrototypeAccessCounts !== 'function') throw Error('requires access-diagnostic profile');
const original = NodeKernelHost.prototype.commonMemoryPrototypeStats, snapshots = [];
NodeKernelHost.prototype.commonMemoryPrototypeStats = async function (...args) {
  const value = await original.apply(this, args);
  snapshots.push(await this.commonMemoryPrototypeAccessCounts());
  return value;
};
const report = { diagnostic: 'region-counts', snapshots, passed: false };
try {
  await import('./wordpress-node.ts');
  const result = JSON.parse(readFileSync(resolve(out, 'result.json')));
  result.diagnostic = 'region-counts';
  writeFileSync(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const trial = result.trial;
  if (!trial?.passed || !result.destroyed || snapshots.length !== 1 + trial.warmup + trial.rounds) throw Error('incomplete WordPress snapshots');
  const counter = JSON.parse(readFileSync(process.env.KANDELO_REGION_REPORT));
  report.delta = regionDelta(snapshots[trial.warmup], snapshots.at(-1), counter);
  if (BigInt(report.delta.totals.accesses) === 0n) throw Error('empty dynamic coverage');
  report.passed = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally { NodeKernelHost.prototype.commonMemoryPrototypeStats = original; }
writeFileSync(resolve(out, 'region-counts.json'), JSON.stringify(report, null, 2) + '\n');
