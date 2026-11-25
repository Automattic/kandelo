import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Executables may leave undefined only the imports the host supplies
// (libc/glue/kandelo-link-imports.txt, generated from base and versioned
// extension declarations). Anything else must fail the link, so
// configure checks tell the truth and programs cannot ship calls to
// functions Kandelo lacks.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cc = join(repo, 'sdk/bin/wasm32posix-cc');

function link(source: string, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'honest-link-'));
  const src = join(dir, 't.c');
  writeFileSync(src, source);
  return spawnSync(cc, [src, '-o', join(dir, 't.wasm'), ...extra], { encoding: 'utf8' });
}

describe('honest executable links', () => {
  it('fails to link a call to a function no library defines', () => {
    const r = link('int no_such_function(void);\nint main(void){return no_such_function();}\n');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/undefined symbol: no_such_function/);
  });

  it('still links an ordinary program', () => {
    const r = link('#include <stdio.h>\nint main(void){puts("ok");return 0;}\n');
    expect(r.status, r.stderr).toBe(0);
  });

  it('applies the executable link contract inside nested compiler response files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honest link response '));
    const src = join(dir, 't.c'), out = join(dir, 't.wasm');
    writeFileSync(src, '#include <stdio.h>\nint main(void){puts("response");return 0;}\n');
    const quote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    const inner = join(dir, 'inner.rsp'), outer = join(dir, 'outer.rsp');
    // Exceeds the SDK's argv transport threshold, as a real Meson link does.
    const padding = Array.from({ length: 1000 }, (_, i) => `-DSDK_RESPONSE_PADDING_${i}=1`);
    writeFileSync(inner, [...padding, src, '-Wl,--start-group', '-lc', '-Wl,--end-group', '-o', out].map(quote).join('\n'));
    writeFileSync(outer, quote('@' + inner));
    const result = spawnSync(cc, ['@' + outer], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const missing = join(dir, 'missing.c');
    writeFileSync(missing, 'int response_undefined(void); int main(void){return response_undefined();}\n');
    writeFileSync(inner, [missing, '-Wl,--start-group', '-lc', '-Wl,--end-group', '-o', out].map(quote).join('\n'));
    const rejected = spawnSync(cc, ['@' + outer], { encoding: 'utf8' });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('undefined symbol: response_undefined');
  });

  it('preserves empty quoted response arguments like direct compiler arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'honest empty response '));
    const src = join(dir, 't.c'), direct = join(dir, 'direct.wasm'), out = join(dir, 'response.wasm');
    writeFileSync(src, 'int main(void){return 0;}\n');
    const argumentsFor = (output: string) => ['-I', '', src, '-o', output];
    const ordinary = spawnSync(cc, argumentsFor(direct), { encoding: 'utf8' });
    expect(ordinary.status, ordinary.stderr).toBe(0);
    const quote = (value: string) => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
    const inner = join(dir, 'inner.rsp'), outer = join(dir, 'outer.rsp');
    writeFileSync(inner, argumentsFor(out).map(quote).join('\n'));
    writeFileSync(outer, quote('@' + inner));
    const response = spawnSync(cc, ['@' + outer], { encoding: 'utf8' });
    expect(response.status, response.stderr).toBe(ordinary.status);
  });

  it('requires the versioned namespace for stack capture', () => {
    const r = link('int __kandelo_stack_capture_v1(void *, unsigned, unsigned);\nint main(void){char b[48];return __kandelo_stack_capture_v1(b,48,1);}\n');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('unsupported required program extension env.__kandelo_stack_capture_v1');
  });

  it('links a typed explicit stack interface and rejects a wrong signature', () => {
    const declaration = '__attribute__((import_module("kandelo.stack.v1"),import_name("__kandelo_stack_capture_v1")))';
    const good = link(`${declaration} int __kandelo_stack_capture_v1(void *, unsigned, unsigned);\nint main(void){char b[48];return __kandelo_stack_capture_v1(b,48,1);}\n`);
    expect(good.status, good.stderr).toBe(0);
    const bad = link(`${declaration} int __kandelo_stack_capture_v1(unsigned);\nint main(void){return __kandelo_stack_capture_v1(0);}\n`);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('incompatible function signature');
  });

  it('configure-style check reports a missing function as absent', () => {
    // autoconf AC_CHECK_FUNCS shape: an unprototyped declaration and a call.
    const r = link('char closesocket();\nint main(void){return closesocket();}\n');
    expect(r.status).not.toBe(0);
  });

  it('never passes --allow-undefined to wasm-ld for an executable', () => {
    const r = link('int main(void){return 0;}\n', ['-###']);
    expect(r.stderr).not.toMatch(/--allow-undefined(?!-file)/);
    expect(r.stderr).toMatch(/--allow-undefined-file=\S*kandelo-link-imports\.txt/);
  });
});
