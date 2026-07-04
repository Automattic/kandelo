import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const sdkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nativeCc = join(sdkRoot, 'kandelo/bin/wasm32posix-cc');
const tempDirs: string[] = [];

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('Kandelo-native cc stack sizing', () => {
  it('applies the floor and retains larger direct and response-file requests', () => {
    const root = mkdtempSync(join(tmpdir(), 'kandelo-native-cc-'));
    tempDirs.push(root);

    const llvm = join(root, 'llvm');
    const sysroot = join(root, 'sysroot');
    const glue = join(root, 'glue');
    const glueObjects = join(root, 'glue-objects');
    const capture = join(root, 'linker-args.txt');
    const source = join(root, 'main.c');
    mkdirSync(llvm);
    mkdirSync(join(sysroot, 'lib'), { recursive: true });
    mkdirSync(glue);
    mkdirSync(glueObjects);

    writeExecutable(join(llvm, 'clang'), `#!/usr/bin/env bash
set -e
while [[ $# -gt 0 ]]; do
  if [[ $1 == -o ]]; then : > "$2"; exit 0; fi
  shift
done
`);
    writeExecutable(join(llvm, 'wasm-ld'), `#!/usr/bin/env bash
set -e
printf '%s\n' "$@" > "$WASM_POSIX_TEST_CAPTURE"
while [[ $# -gt 0 ]]; do
  if [[ $1 == -o ]]; then : > "$2"; exit 0; fi
  shift
done
`);
    writeFileSync(source, 'int main(void) { return 0; }\n');
    for (const path of [
      join(sysroot, 'lib/libc.a'),
      join(sysroot, 'lib/crt1.o'),
      join(glue, 'channel_syscall.c'),
      join(glueObjects, 'channel_syscall.o'),
      join(glueObjects, 'compiler_rt.o'),
      join(glueObjects, 'cxxrt.o'),
    ]) writeFileSync(path, '');

    const env = {
      ...process.env,
      WASM_POSIX_GLUE_DIR: glue,
      WASM_POSIX_GLUE_OBJ_DIR: glueObjects,
      WASM_POSIX_LLVM_DIR: llvm,
      WASM_POSIX_SYSROOT: sysroot,
      WASM_POSIX_TEST_CAPTURE: capture,
    };
    const response = join(root, 'objects.rsp');
    writeFileSync(response, '-z\nstack-size=16777216\n');

    const cases: Array<[string[], string]> = [
      [[], 'stack-size=8388608'],
      [['-Wl,-z,stack-size=1048576'], 'stack-size=8388608'],
      [['-Wl,-z,stack-size=016777216'], 'stack-size=16777216'],
      [['-Wl,-z,stack-size=16777216'], 'stack-size=16777216'],
      [[`-Wl,@${response}`], 'stack-size=16777216'],
    ];

    for (const [linkArgs, expected] of cases) {
      execFileSync('bash', [nativeCc, source, ...linkArgs, '-o', join(root, 'out.wasm')], {
        cwd: root,
        env,
      });
      const emitted = readFileSync(capture, 'utf8').trim().split('\n');
      expect(emitted.filter((arg) => arg.startsWith('stack-size=')).at(-1)).toBe(expected);
      expect(emitted).not.toContain('stack-size=016777216');
    }
  });
});
