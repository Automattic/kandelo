import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { collectNodejsLibraryTests, parseNodejsTestMetadata, nodejsTarget, repoRoot, ensureSourceModuleBoundary, sourceFiles, sourceTreeHash, preparePinnedArchive, fileHash } from '../../scripts/nodejs-source-helper';
import { classifyNodejsResult } from '../../scripts/nodejs-test-results';
import { runNativeNodejsCase } from '../../scripts/nodejs-native-runner';

const directory = mkdtempSync(join(tmpdir(), 'kandelo-nodejs-harness-'));
mkdirSync(join(directory, 'test/parallel'), { recursive: true });
mkdirSync(join(directory, 'test/sequential'), { recursive: true });
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function fixture(name: string, source: string) {
  const path = join(directory, 'test/parallel', `test-${name}.js`);
  writeFileSync(path, source);
  return collectNodejsLibraryTests(directory, [`test-${name}.js`])[0];
}

describe('pinned Node upstream harness', () => {
  it('matches upstream metadata and accounts for both js and mjs inventory', () => {
    expect(parseNodejsTestMetadata('// Flags: --expose-gc --stack-size=100\n// Env: A=x=y B=two\n// RLIMIT_AS: 123\nrequire("node:test");'))
      .toEqual({ flags: ['--expose-gc', '--stack-size=100'], env: { A: 'x=y', B: 'two' }, rlimitAs: 123, nodeTest: true });
    fixture('inventory', '');
    writeFileSync(join(directory, 'test/sequential/test-esm.mjs'), '');
    writeFileSync(join(directory, 'test/sequential/helper.js'), '');
    const cases = collectNodejsLibraryTests(directory);
    expect(cases.some(test => test.name === 'sequential/test-esm.mjs')).toBe(true);
    expect(cases.some(test => test.name.endsWith('helper.js'))).toBe(false);
    expect(() => collectNodejsLibraryTests(directory, ['typo'])).toThrow();
    expect(() => collectNodejsLibraryTests(directory, ['../test-inventory.js'])).toThrow();
  });

  it('preserves and verifies nested node_modules and out fixtures', () => {
    const source = join(directory, 'archive-input'), cache = join(directory, 'archive-cache');
    mkdirSync(join(source, 'test/fixtures/node_modules/pkg'), { recursive: true });
    mkdirSync(join(source, 'test/fixtures/out'), { recursive: true });
    mkdirSync(cache);
    writeFileSync(join(source, 'test/fixtures/node_modules/pkg/index.js'), 'module.exports=42;');
    writeFileSync(join(source, 'test/fixtures/out/data'), 'fixture');
    expect(sourceFiles(source)).toContain('test/fixtures/node_modules/pkg/index.js');
    expect(sourceFiles(source)).toContain('test/fixtures/out/data');
    const archive = join(cache, 'pinned.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', source, '.']);
    const artifact = { url: 'https://example.invalid/pinned.tar.gz', sha256: fileHash(archive) };
    const prepared = preparePinnedArchive(cache, artifact);
    expect(sourceTreeHash(prepared.directory)).toBe(sourceTreeHash(source));
    writeFileSync(join(prepared.directory, 'test/fixtures/node_modules/pkg/index.js'), 'tampered');
    expect(() => preparePinnedArchive(cache, artifact)).toThrow('Pinned extraction changed');
  });

  it('isolates a CommonJS source cache from a surrounding module repository', () => {
    const parent = join(directory, 'module-parent'), cache = join(parent, 'cache');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(parent, 'package.json'), '{"type":"module"}');
    ensureSourceModuleBoundary(cache);
    const probe = join(cache, 'probe.js');
    writeFileSync(probe, 'require("assert").strictEqual(typeof require,"function");');
    execFileSync(process.execPath, [probe]);
    writeFileSync(join(cache, 'package.json'), '{"type":"module"}');
    expect(() => ensureSourceModuleBoundary(cache)).toThrow('Cache module boundary differs');
  });

  it('does not turn harness errors, timeouts, unsupported flags or TAP failures into passes', () => {
    const result = { exitCode: 0, stdout: '', stderr: '', durationMs: 1 };
    expect(classifyNodejsResult(result)).toBe('pass');
    expect(classifyNodejsResult({ ...result, stdout: '1..0 # Skipped: no capability\n' })).toBe('upstream-skip');
    expect(classifyNodejsResult({ ...result, stdout: 'not ok 1 - assertion\n' })).toBe('fail');
    expect(classifyNodejsResult({ ...result, stdout: '# fail 1\n' })).toBe('fail');
    expect(classifyNodejsResult({ ...result, timeout: true })).toBe('timeout');
    expect(classifyNodejsResult({ ...result, error: 'worker failed' })).toBe('harness-error');
    expect(classifyNodejsResult({ ...result, unsupported: '--missing-flag' })).toBe('unsupported');
    expect(classifyNodejsResult({ ...result, exitCode: 7, stdout: '1..0 # Skipped: nope' })).toBe('fail');
  });

  it('executes real flags and environment, catches assertions/exit listeners and kills timed-out groups', async () => {
    const cases: Array<[string, string, string]> = [
      ['pass', 'require("assert").strictEqual(1, 1)', 'pass'],
      ['assertion', 'require("assert").strictEqual(1, 2)', 'fail'],
      ['exit-listener', 'process.on("exit",()=>{throw Error("unfulfilled exit assertion")})', 'fail'],
      ['exit-status', 'process.exit(7)', 'fail'],
      ['skip', 'console.log("1..0 # Skipped: fixture")', 'upstream-skip'],
      ['flags', '// Flags: --expose-gc\nrequire("assert").strictEqual(typeof global.gc,"function");require("assert").ok(process.execArgv.includes("--expose-gc"));', 'pass'],
      ['env', '// Env: KANDELO_HARNESS_FIXTURE=real\nrequire("assert").strictEqual(process.env.KANDELO_HARNESS_FIXTURE,"real");', 'pass'],
      ['timeout', 'console.log(process.pid);setInterval(()=>{},1000)', 'timeout'],
    ];
    for (const [name, source, status] of cases) {
      const descriptor = fixture(name, source);
      const result = await runNativeNodejsCase(process.execPath, directory, descriptor, name === 'timeout' ? 500 : 5000, join(directory, name), directory);
      expect(classifyNodejsResult(result), JSON.stringify(result)).toBe(status);
      if (name === 'timeout') {
        const pid = Number(result.stdout.trim());
        expect(pid).toBeGreaterThan(0);
        expect(() => process.kill(pid, 0)).toThrow();
      }
    }
    const missing = await runNativeNodejsCase('/does-not-exist/node', directory, fixture('missing', ''), 500, join(directory, 'missing'), directory);
    expect(classifyNodejsResult(missing)).toBe('harness-error');
  }, 20_000);

  it('generates matching JavaScript and C target metadata without compiling packages', () => {
    const output = join(directory, 'bootstrap.js'), header = join(directory, 'bootstrap.h');
    execFileSync('python3', [join(repoRoot, 'scripts/generate-node-bootstrap.py'),
      join(repoRoot, 'packages/registry/spidermonkey/node-compat/adapter.js'),
      join(repoRoot, 'packages/registry/node-compat/bootstrap.js'),
      join(repoRoot, 'packages/registry/spidermonkey/node-compat/suffix.js'), output, header,
      join(repoRoot, 'third_party/node-web-platform/node-web-platform.js'),
      join(repoRoot, 'packages/registry/node-compat/target.json')]);
    execFileSync(process.execPath, ['--check', output]);
    expect(readFileSync(header, 'utf8')).toContain(`#define KANDELO_NODE_COMPAT_VERSION "v${nodejsTarget.version}"`);
    expect(readFileSync(output, 'utf8')).toContain(`"version": "${nodejsTarget.version}"`);
    expect(readFileSync(join(repoRoot, 'packages/registry/spidermonkey/patches/0012-kandelo-node-compat-shell-entry.patch'), 'utf8'))
      .toContain('puts(KANDELO_NODE_COMPAT_VERSION)');
  });
});
