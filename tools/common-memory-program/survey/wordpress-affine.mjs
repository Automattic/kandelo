import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { affineDelta } from './affine-counts.mjs';
const [profile,,, out] = process.argv.slice(2);
if (existsSync(out)) throw Error('choose fresh affine output');
mkdirSync(out, { recursive: true });
const { NodeKernelHost } = await import(pathToFileURL(resolve(profile, 'node-kernel-host.mjs')).href);
if (typeof NodeKernelHost.prototype.commonMemoryPrototypeAccessCounts !== 'function') throw Error('requires access-diagnostic profile');
const original = NodeKernelHost.prototype.commonMemoryPrototypeStats, snapshots = [];
NodeKernelHost.prototype.commonMemoryPrototypeStats = async function (...args) { const value = await original.apply(this, args); snapshots.push(await this.commonMemoryPrototypeAccessCounts()); return value; };
const report = { diagnostic: 'affine-counts', snapshots, passed: false };
try {
  await import('./wordpress-node.ts');
  const result = JSON.parse(readFileSync(resolve(out, 'result.json')));
  result.diagnostic = 'affine-counts'; writeFileSync(resolve(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  const trial = result.trial;
  if (!trial?.passed || !result.destroyed || snapshots.length !== 1 + trial.warmup + trial.rounds) throw Error('incomplete WordPress snapshots');
  report.delta = affineDelta(snapshots[trial.warmup], snapshots.at(-1), JSON.parse(readFileSync(process.env.KANDELO_AFFINE_REPORT)));
  if (BigInt(report.delta.totals.wrappedAttempts) === 0n) throw Error('empty affine observation');
  report.passed = true;
} catch (error) { report.error = String(error.stack || error); process.exitCode = 1; }
finally { NodeKernelHost.prototype.commonMemoryPrototypeStats = original; }
writeFileSync(resolve(out, 'affine-counts.json'), JSON.stringify(report, null, 2) + '\n');
