// Tests for driver.mjs. Run: node --test tests/runtime-workarounds/driver.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from './driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const driver = join(here, 'driver.mjs');

function drive(fixture, { kind, entry, target, timeoutSeconds = 60, env }) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      driver,
      '--dir', join(here, '_fixtures', fixture),
      '--kind', kind,
      '--entry', entry,
      '--target', target,
      '--attempts', '1',
      '--min-reproduced', '1',
      '--timeout-seconds', String(timeoutSeconds),
      '--crash-is-reproduced', '0',
    ],
    { encoding: 'utf8', env: env ?? process.env },
  );
  const lines = result.stdout.trim().split('\n');
  let verdict = null;
  try {
    verdict = JSON.parse(lines[lines.length - 1]);
  } catch {
    // A harness failure prints no verdict line.
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    seconds: (Date.now() - started) / 1000,
    verdict,
  };
}

/** Exit 3, a message on stderr, and no verdict line on stdout. */
function assertHarnessFailure(r, pattern) {
  assert.equal(r.status, 3, `status ${r.status}; stderr: ${r.stderr}`);
  assert.equal(r.verdict, null, `printed a verdict: ${r.stdout}`);
  assert.match(r.stderr, pattern);
}

const page = (fixture, extra = {}) =>
  drive(fixture, { kind: 'browser-page', entry: 'repro.html', target: 'chromium', ...extra });

test('a page that reports reproduced is reproduced', () => {
  const r = page('reports-reproduced');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.verdict.verdict, 'reproduced');
  // The version is the browser's own; the record's runtime field names the engine.
  assert.match(r.verdict.version, /^\d+\.\d/);
  assert.ok(['macos', 'linux', 'windows'].includes(r.verdict.os), r.verdict.os);
  assert.match(r.verdict.details, /fixture says the defect is present/);
});

test('a page that reports not-reproduced is not-reproduced', () => {
  const r = page('reports-not-reproduced');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.verdict.verdict, 'not-reproduced');
});

test('a page that never reports is inconclusive at the timeout', () => {
  const r = page('never-reports', { timeoutSeconds: 3 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.verdict.verdict, 'inconclusive');
  assert.ok(r.seconds < 15, `took ${r.seconds}s`);
});

test('a page that hangs its main thread is inconclusive at the timeout', () => {
  const r = page('busy-loop', { timeoutSeconds: 3 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.verdict.verdict, 'inconclusive');
  assert.ok(r.seconds < 15, `took ${r.seconds}s`);
});

test('a node script repro reports through REPRO-VERDICT', () => {
  const r = drive('node-script', { kind: 'script', entry: 'repro.mjs', target: 'node' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.verdict.verdict, 'reproduced');
  assert.match(r.verdict.version, /^v\d/);
  assert.match(r.verdict.details, /fixture script says the defect is present/);
});

test('a script that outlives the timeout is killed and inconclusive', () => {
  const r = drive('sleeps', { kind: 'script', entry: 'repro.mjs', target: 'node', timeoutSeconds: 2 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.verdict.verdict, 'inconclusive');
  assert.match(r.verdict.details, /no verdict within 2s/);
  assert.ok(r.seconds < 15, `took ${r.seconds}s`);
});

test('a script that exits without a REPRO-VERDICT line is inconclusive', () => {
  const r = drive('exits-silently', { kind: 'script', entry: 'repro.mjs', target: 'node' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.verdict.verdict, 'inconclusive');
  assert.match(r.verdict.details, /without a REPRO-VERDICT line/);
});

test('a browser target Playwright does not have is a harness failure', () => {
  const r = page('reports-reproduced', { target: 'netscape' });
  assertHarnessFailure(r, /driver: harness failure: .*netscape/);
});

test('a browser that cannot be launched is a harness failure, not inconclusive', () => {
  // A browsers directory that does not exist: Playwright finds no executable.
  const r = page('reports-reproduced', {
    timeoutSeconds: 10,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(here, '_fixtures', 'does-not-exist') },
  });
  assertHarnessFailure(r, /driver: harness failure: could not launch chromium/);
});

test('a script runtime that is not installed is a harness failure', () => {
  // `bun` resolves through PATH; an empty PATH cannot find it.
  const r = drive('node-script', {
    kind: 'script',
    entry: 'repro.mjs',
    target: 'bun',
    env: { ...process.env, PATH: join(here, '_fixtures', 'does-not-exist') },
  });
  assertHarnessFailure(r, /driver: harness failure: could not run bun/);
});

test('aggregate', () => {
  assert.equal(aggregate(['crashed'], 1, true), 'reproduced');
  assert.equal(aggregate(['crashed'], 1, false), 'inconclusive');
  assert.equal(aggregate(['reproduced', 'not-reproduced'], 1, false), 'reproduced');
  assert.equal(aggregate(['not-reproduced', 'not-reproduced'], 1, false), 'not-reproduced');
  assert.equal(aggregate(['not-reproduced', 'inconclusive'], 1, false), 'inconclusive');
  assert.equal(aggregate(['reproduced', 'not-reproduced'], 2, false), 'inconclusive');
});
