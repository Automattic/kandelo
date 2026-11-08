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
