import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Executables may leave undefined only the imports the host supplies
// (libc/glue/kandelo-host-imports.txt, generated from
// shared::abi::HOST_ENV_IMPORTS). Anything else must fail the link, so
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

  it('configure-style check reports a missing function as absent', () => {
    // autoconf AC_CHECK_FUNCS shape: an unprototyped declaration and a call.
    const r = link('char closesocket();\nint main(void){return closesocket();}\n');
    expect(r.status).not.toBe(0);
  });

  it('never passes --allow-undefined to wasm-ld for an executable', () => {
    const r = link('int main(void){return 0;}\n', ['-###']);
    expect(r.stderr).not.toMatch(/--allow-undefined(?!-file)/);
    expect(r.stderr).toMatch(/--allow-undefined-file=\S*kandelo-host-imports\.txt/);
  });
});
