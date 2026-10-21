import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('keeps a virtual call typed after inlining it into a try region', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kandelo-vcall-facts-'));
  try {
    const source = join(root, 'foo.cpp');
    const object = join(root, 'foo.o');
    writeFileSync(source, [
      'struct Foo { virtual ~Foo(); virtual void bar(); };',
      'template <typename F> void baz(F &&f) { try { f(); } catch (...) { __builtin_trap(); } }',
      'void *qux(void *arg) { Foo *foo = static_cast<Foo *>(arg); baz([&] { foo->bar(); }); return nullptr; }',
    ].join('\n'));
    await promisify(execFile)('wasm32posix-c++', ['-O2', '-c', source, '-o', object]);
    const sections = WebAssembly.Module.customSections(
      new WebAssembly.Module(readFileSync(object)), 'kandelo.calltypes',
    );
    expect(sections).toHaveLength(1);
    const records = Buffer.from(sections[0]!).toString('utf8').split('\n');
    expect(records).toContain('S\tqux(void*)\t0\ti32->\tvcall\t_ZTS3Foo\t8');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
