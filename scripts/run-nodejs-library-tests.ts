#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { nodejsTarget, targetPath, repoRoot, collectNodejsLibraryTests, auditNodejsCategories,
  prepareNodejsSource, prepareNodejsReference, fileHash, hash, sourceTreeHash, type NodejsTestDescriptor } from './nodejs-source-helper';
import { classifyNodejsResult, type NodejsRun } from './nodejs-test-results';
import { runNativeNodejsCase } from './nodejs-native-runner';

type Host = 'native' | 'node' | 'chromium' | 'firefox' | 'webkit';
async function main() {
  const args = process.argv.slice(2), selectors: string[] = [];
  let host: Host = 'node', timeout = 30_000, limit = Infinity, list = false, resume = false, prepare = false;
  let cache = join(repoRoot, '.context/nodejs-lts-cache'), out: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--host') host = args[++i] as Host;
    else if (arg === '--timeout') timeout = Number(args[++i]) * 1000;
    else if (arg === '--limit') limit = Number(args[++i]);
    else if (arg === '--cache') cache = resolve(args[++i]);
    else if (arg === '--out') out = resolve(args[++i]);
    else if (arg === '--list') list = true;
    else if (arg === '--resume') resume = true;
    else if (arg === '--prepare-only') prepare = true;
    else if (arg === '--all' || arg === '--json') { /* inventory/result JSON is always emitted */ }
    else if (arg === '--help') {
      console.log(`Usage: scripts/run-nodejs-library-tests.sh [options] [category/test-name ...]
  --host native|node|chromium|firefox|webkit  One host per resumable report
  --list                Emit pinned parallel/sequential inventory and category audit
  --prepare-only        Download and verify pinned source/reference; no guest build
  --all                 Full parallel/sequential inventory (default)
  --limit N             Bound new cases this invocation; pending cases stay visible
  --timeout SECONDS     Per-case deadline (default 30)
  --out DIR --resume    Continue a matching manifest; never reuse another runtime's results
  --cache DIR           Pinned source/reference cache (default .context/nodejs-lts-cache)
No command compiles packages. Missing/stale guest products fail preflight.
Other upstream categories are audited but require separate configuration support.`);
      return;
    } else if (arg.startsWith('-')) throw Error(`Unknown option: ${arg}`);
    else selectors.push(arg);
  }
  if (!['native', 'node', 'chromium', 'firefox', 'webkit'].includes(host)) throw Error(`Invalid host: ${host}`);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647 || !(limit > 0) || (limit !== Infinity && !Number.isInteger(limit))) throw Error('Invalid timeout or limit');
  if (resume && !out) throw Error('--resume requires --out');
  out ??= join(repoRoot, '.context/nodejs-results', host + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(out, { recursive: true });
  mkdirSync(join(out, 'logs'), { recursive: true });
  mkdirSync(join(out, 'tmp'), { recursive: true });
  const source = prepareNodejsSource(cache);
  const inventory = collectNodejsLibraryTests(source.directory, selectors);
  const categories = auditNodejsCategories(source.directory);
  if (list) { const listing = { target: nodejsTarget, source, scope: ['parallel', 'sequential'], categories, count: inventory.length, inventory }; writeFileSync(join(out, 'inventory.json'), JSON.stringify(listing, null, 2) + '\n'); console.log(JSON.stringify(listing, null, 2)); return; }
  const reference = host === 'native' || prepare ? prepareNodejsReference(cache) : undefined;
  if (prepare) { console.log(JSON.stringify({ target: nodejsTarget, source, reference, inventoryCount: inventory.length, categories }, null, 2)); return; }
  const code = ['scripts/run-nodejs-library-tests.ts', 'scripts/nodejs-source-helper.ts', 'scripts/nodejs-native-runner.ts',
    'scripts/nodejs-test-results.ts', 'scripts/nodejs-guest-runner.ts', 'scripts/nodejs-browser-runner.ts', 'scripts/build-nodejs-test-vfs-image.ts',
    'apps/browser-demos/playwright.config.ts',
    'packages/registry/node-compat/bootstrap.js', 'third_party/node-web-platform/node-web-platform.js']
    .map(path => ({ path, sha256: fileHash(join(repoRoot, path)) }));
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const hostInputs = { runtimeSource: sourceTreeHash(join(repoRoot, 'host/src')),
    builtHost: existsSync(join(repoRoot, 'host/dist')) ? sourceTreeHash(join(repoRoot, 'host/dist')) : null,
    flake: fileHash(join(repoRoot, 'flake.nix')), lock: fileHash(join(repoRoot, 'flake.lock')),
    devShell: fileHash(join(repoRoot, 'scripts/dev-shell.sh')), versions: process.versions };
  let guest: Awaited<ReturnType<typeof import('./nodejs-guest-runner').createNodejsGuestRunner>> | undefined;
  try {
    let runtime: Record<string, unknown> = { ...reference };
    if (host !== 'native') {
      const { buildNodejsTestImage } = await import('./build-nodejs-test-vfs-image');
      const image = join(out, 'suite.vfs');
      const imageIdentity = await buildNodejsTestImage(source.directory, image);
      const { createNodejsGuestRunner } = await import('./nodejs-guest-runner');
      guest = await createNodejsGuestRunner(host, image);
      runtime = { ...guest.identity, ...imageIdentity };
      const preflight: NodejsTestDescriptor = { name: '__target_preflight', relPath: '.kandelo-target-probe.cjs',
        hostPath: '', vfsPath: '/node-src/.kandelo-target-probe.cjs', sha256: '', flags: [], env: {}, nodeTest: false };
      const probe = await guest.run(preflight, timeout);
      writeFileSync(join(out, 'preflight.json'), JSON.stringify(probe, null, 2));
      const expected = `KANDELO_NODE_TARGET:v${nodejsTarget.version}:kandelo:wasm32`;
      if (classifyNodejsResult(probe) !== 'pass' || !probe.stdout.includes(expected)) {
        throw Error(`Guest target preflight failed; expected ${expected}. Products need rebuilding through the normal path. No upstream cases ran. See ${join(out, 'preflight.json')}`);
      }
    }
    if (guest) {
      const sanity = await guest.run({ name: '__assert_preflight', relPath: '.kandelo-assert-probe.cjs',
        hostPath: '', vfsPath: '/node-src/.kandelo-assert-probe.cjs', sha256: '', flags: [], env: {}, nodeTest: false }, timeout);
      writeFileSync(join(out, 'assert-preflight.json'), JSON.stringify(sanity, null, 2));
      if (classifyNodejsResult(sanity) !== 'pass' || !sanity.stdout.includes('KANDELO_ASSERT_SANITY:4')) {
        throw Error('Guest assert preflight failed: upstream passing counts would be unreliable. Fix core assert before running the baseline.');
      }
    }
    const contract = { schema: 1, gitHead, hostInputs, target: nodejsTarget, pinSha256: fileHash(targetPath), source, host,
      timeoutMs: timeout, selectors, inventory, categories, runtime, runner: process.version, code };
    const fingerprint = hash(JSON.stringify(contract));
    const manifestPath = join(out, 'manifest.json');
    if (existsSync(manifestPath)) {
      const old = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!resume) throw Error(`Report exists; use --resume: ${out}`);
      if (old.fingerprint !== fingerprint) throw Error('Resume contract changed: target/source/inventory/runtime/flags/timeout/runner must match');
    } else {
      if (resume) throw Error('Cannot resume without an existing manifest');
      writeFileSync(manifestPath, JSON.stringify({ fingerprint, createdAt: new Date().toISOString(),
        gitHead, contract }, null, 2) + '\n');
    }
    const resultPath = join(out, 'results.jsonl');
    const rows = existsSync(resultPath) ? readFileSync(resultPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const done = new Set<string>();
    const names = new Set(inventory.map(test => test.name));
    for (const row of rows) {
      if (row.fingerprint !== fingerprint || !names.has(row.test) || done.has(row.test)) throw Error('Invalid, stale, or duplicate result row');
      done.add(row.test);
    }
    let ran = 0;
    for (const test of inventory) {
      if (done.has(test.name)) continue;
      if (ran >= limit) break;
      const logPrefix = join(out, 'logs', test.name.replaceAll('/', '__'));
      let raw: NodejsRun;
      const caseStart = performance.now();
      try {
        if (host === 'native') raw = await runNativeNodejsCase(reference!.executable, source.directory, test, timeout, logPrefix, join(out, 'tmp'));
        else {
          const { unsupportedGuestRequirements } = await import('./nodejs-guest-runner');
          const unsupported = unsupportedGuestRequirements(test);
          raw = unsupported ? { exitCode: null, stdout: '', stderr: '', durationMs: 0, unsupported } : await guest!.run(test, timeout);
        }
      } catch (error) {
        raw = { exitCode: null, stdout: '', stderr: '', durationMs: Math.round(performance.now() - caseStart), error: String(error) };
      }
      // Native output is already streamed to disk. Preserve full guest logs too.
      if (host !== 'native' || !existsSync(logPrefix + '.stdout')) {
        writeFileSync(logPrefix + '.stdout', raw.stdoutChunks ? Buffer.concat(raw.stdoutChunks.map(chunk => Buffer.from(chunk, 'base64'))) : raw.stdout);
        writeFileSync(logPrefix + '.stderr', raw.stderrChunks ? Buffer.concat(raw.stderrChunks.map(chunk => Buffer.from(chunk, 'base64'))) : raw.stderr);
      }
      const { stdout, stderr, stdoutChunks, stderrChunks, ...details } = raw;
      const row = { fingerprint, test: test.name, host, status: classifyNodejsResult(raw), ...details,
        stdout: 'logs/' + test.name.replaceAll('/', '__') + '.stdout', stderr: 'logs/' + test.name.replaceAll('/', '__') + '.stderr' };
      appendFileSync(resultPath, JSON.stringify(row) + '\n');
      rows.push(row); done.add(test.name); ran++;
      console.log(JSON.stringify(row));
      const counts = Object.fromEntries(['pass', 'fail', 'upstream-skip', 'unsupported', 'timeout', 'harness-error'].map(status => [status, rows.filter(row => row.status === status).length]));
      writeFileSync(join(out, 'summary.json'), JSON.stringify({ fingerprint, host, target: nodejsTarget.version,
        inventory: inventory.length, finalized: done.size, pending: inventory.length - done.size,
        complete: done.size === inventory.length, counts }, null, 2) + '\n');
      if (raw.error) break; // Keep the remaining inventory pending after a harness failure.
    }
    console.error(`Finalized ${done.size}/${inventory.length}; ${inventory.length - done.size} pending. Report: ${out}`);
    // Incomplete and unsupported outcomes never become a green full-suite claim.
    if (rows.some(row => ['fail', 'timeout', 'harness-error'].includes(row.status))) process.exitCode = 1;
    else if (done.size !== inventory.length || rows.some(row => row.status === 'unsupported')) process.exitCode = 2;
  } catch (error) {
    writeFileSync(join(out, 'run-error.json'), JSON.stringify({ error: String(error), host, target: nodejsTarget.version, inventory: inventory.length }, null, 2) + '\n');
    throw error;
  } finally { await guest?.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
