// Tests for driver.mjs. Run: node --test tests/runtime-workarounds/driver.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from './driver.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const driver = join(here, 'driver.mjs');

function drive(fixture, { kind, entry, target, timeoutSeconds = 60 }) {
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
    { encoding: 'utf8' },
  );
  const lines = result.stdout.trim().split('\n');
  return {
    status: result.status,
    stderr: result.stderr,
    seconds: (Date.now() - started) / 1000,
    verdict: JSON.parse(lines[lines.length - 1]),
  };
}

const page = (fixture, extra = {}) =>
  drive(fixture, { kind: 'browser-page', entry: 'repro.html', target: 'chromium', ...extra });

test('a page that reports reproduced is reproduced', () => {
  const r = page('reports-reproduced');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.verdict.verdict, 'reproduced');
  assert.match(r.verdict.version, /^chromium /);
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

test('aggregate', () => {
  assert.equal(aggregate(['crashed'], 1, true), 'reproduced');
  assert.equal(aggregate(['crashed'], 1, false), 'inconclusive');
  assert.equal(aggregate(['reproduced', 'not-reproduced'], 1, false), 'reproduced');
  assert.equal(aggregate(['not-reproduced', 'not-reproduced'], 1, false), 'not-reproduced');
  assert.equal(aggregate(['not-reproduced', 'inconclusive'], 1, false), 'inconclusive');
  assert.equal(aggregate(['reproduced', 'not-reproduced'], 2, false), 'inconclusive');
});
