import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { inflateSync } from 'node:zlib';
import { expect, it } from 'vitest';

it('preserves every record when the compiler packs a large facts chunk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kandelo-packed-facts-'));
  const names = Array.from({ length: 512 }, (_, i) => `large_facts_${i}_${'x'.repeat(180)}`);
  try {
    const source = join(root, 'large.c');
    const object = join(root, 'large.o');
    writeFileSync(source, names.map(name =>
      `void ${name}(void (*callback)(int)) { callback(3); callback(5); callback(9); }`
    ).join('\n'));
    await promisify(execFile)('wasm32posix-cc', ['-O1', '-c', source, '-o', object], {
      maxBuffer: 1024 * 1024,
    });
    const sections = WebAssembly.Module.customSections(
      new WebAssembly.Module(readFileSync(object)), 'kandelo.calltypes',
    );
    expect(sections).toHaveLength(1);
    const frame = Buffer.from(sections[0]!);
    expect(frame.subarray(0, 8)).toEqual(Buffer.from('KCTZ\0\0\0\x01', 'binary'));
    const rawSize = Number(frame.readBigUInt64LE(8));
    const packedSize = Number(frame.readBigUInt64LE(16));
    expect(rawSize).toBeGreaterThanOrEqual(1024 * 1024);
    expect(frame.byteLength).toBe(24 + packedSize);
    expect(packedSize).toBeLessThan(rawSize);
    const text = inflateSync(frame.subarray(24), { maxOutputLength: rawSize });
    expect(text.byteLength).toBe(rawSize);
    const records = text.toString('utf8');
    expect(records).toMatch(/^#kandelo-calltypes\t5\nM\t/);
    const definitions = records.split('\n').filter(line => line.startsWith('F\t'));
    expect(definitions).toHaveLength(names.length);
    for (const name of names) expect(definitions.some(line => line.startsWith(`F\t${name}\t`))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
