import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const fixture = fileURLToPath(new URL('./fixtures/node-dns-platform-control.cjs', import.meta.url));
describe.skipIf(process.versions.node !== target.version)('pinned DNS lookup and actual observation with native boundaries', () => {
  it('full Resolver algorithms with actual loopback DNS and native channels', () => {
    const resolverFixture = fileURLToPath(new URL('./fixtures/node-dns-resolver-control.cjs', import.meta.url));
    const result = spawnSync(process.execPath, ['--expose-internals', resolverFixture], { encoding: 'utf8', timeout: 20_000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim());
    expect(report.fail).toBe(0);
    expect(report.pass).toBe(26);
    expect(report.cases).toHaveLength(26);
  });
  for (const name of ['literalTimingAndOptions', 'nativeLookupAndService', 'errorAndValidation', 'observerAndPublicEntries']) {
    it(name, () => {
      const result = spawnSync(process.execPath, ['--expose-internals', fixture, name], { encoding: 'utf8', timeout: 15_000 });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual({ case: name, passed: true,
        scope: 'Pinned candidate DNS/observer algorithms over real native Node request/OS/clock boundaries; no guest conformance' });
    });
  }
});
