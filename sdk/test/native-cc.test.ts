import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildClangArgs } from '../src/bin/cc.ts';
import { resolveToolchain } from '../src/lib/toolchain.ts';

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

describe('Kandelo-native cc driver', () => {
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
if [[ \${1:-} == -### ]]; then
  case "\${WASM_POSIX_TEST_TRACE_MODE:-link}" in
    foreign)
      printf ' "/other/wasm-ld" "-m" "wasm32"\n' >&2
      ;;
    duplicate)
      printf ' "%s/wasm-ld" "-m" "wasm32"\n' "$(dirname "$0")" >&2
      printf ' "%s/wasm-ld" "-m" "wasm32"\n' "$(dirname "$0")" >&2
      ;;
    *)
      printf ' "%s/wasm-ld" "-m" "wasm32"\n' "$(dirname "$0")" >&2
      ;;
  esac
  exit 0
fi
while [[ $# -gt 0 ]]; do
  if [[ $1 == -o ]]; then : > "$2"; exit 0; fi
  shift
done
`);
    writeExecutable(join(llvm, 'wasm-ld'), `#!/usr/bin/env bash
set -e
if [[ \${1:-} == --version ]]; then printf '%s\n' 'LLD 21.1.7'; exit 0; fi
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
    const responseValues = {
      decimalLarge: '16777216',
      leadingOctalLarge: '0100000000',
      explicitOctalLarge: '0o100000000',
      hexLarge: '0x1000000',
      hexUpperLarge: '0X1000000',
      binaryLarge: '0b1000000000000000000000000',
      binaryUpperLarge: '0B1000000000000000000000000',
      leadingOctalSmall: '020000000',
      invalidDecimal: '16777216z',
      invalidOctal: '08',
      invalidExplicitOctal: '0o8',
      invalidHex: '0xg',
      invalidBinary: '0b2',
      overflowHex: '0x40000001',
    };
    const responses = Object.fromEntries(
      Object.entries(responseValues).map(([name, value]) => {
        const path = join(root, `${name}.rsp`);
        writeFileSync(path, `-z\nstack-size=${value}\n`);
        return [name, path];
      }),
    );
    const nestedResponse = join(root, 'inner stack.rsp');
    const outerResponse = join(root, 'outer.rsp');
    const clangResponse = join(root, 'clang.rsp');
    writeFileSync(nestedResponse, "-z 'stack-size=0x1000000'\n");
    writeFileSync(
      outerResponse,
      `"${join(root, 'not-stack-size=33554432.o')}" @${nestedResponse.replace(' ', '\\ ')}\n`,
    );
    writeFileSync(
      clangResponse,
      '-Xlinker -z -Xlinker stack-size=0x1000000\n',
    );

    const cases: Array<{
      linkArgs: string[];
      expected: string;
      preserved?: string[];
    }> = [
      { linkArgs: [], expected: 'stack-size=8388608' },
      {
        linkArgs: ['-Wl,-z,stack-size=1048576'],
        expected: 'stack-size=8388608',
        preserved: ['stack-size=1048576'],
      },
      {
        linkArgs: ['-Wl,-z,stack-size=020000000'],
        expected: 'stack-size=8388608',
        preserved: ['stack-size=020000000'],
      },
      ...[
        '16777216',
        '0100000000',
        '0o100000000',
        '0x1000000',
        '0X1000000',
        '0b1000000000000000000000000',
        '0B1000000000000000000000000',
      ].map((value) => ({
        linkArgs: [`-Wl,-z,stack-size=${value}`],
        expected: 'stack-size=16777216',
        preserved: [`stack-size=${value}`],
      })),
      {
        linkArgs: ['-Wl,-zstack-size=0x1000000'],
        expected: 'stack-size=16777216',
        preserved: ['-zstack-size=0x1000000'],
      },
      {
        linkArgs: ['-Xlinker', '-z', '-Xlinker', 'stack-size=0o100000000'],
        expected: 'stack-size=16777216',
        preserved: ['-z', 'stack-size=0o100000000'],
      },
      {
        linkArgs: ['-z', 'stack-size=0b1000000000000000000000000'],
        expected: 'stack-size=16777216',
        preserved: ['-z', 'stack-size=0b1000000000000000000000000'],
      },
      {
        linkArgs: [
          '-Wl,-z', '-O2', '-g', '-fvisibility=hidden',
          '-Wl,stack-size=16777216',
        ],
        expected: 'stack-size=16777216',
        preserved: ['-z', 'stack-size=16777216'],
      },
      {
        linkArgs: [`@${clangResponse}`],
        expected: 'stack-size=16777216',
        preserved: ['-z', 'stack-size=0x1000000'],
      },
      {
        linkArgs: [`-Wl,@${outerResponse}`],
        expected: 'stack-size=16777216',
        preserved: [`@${outerResponse}`],
      },
      ...[
        'decimalLarge',
        'leadingOctalLarge',
        'explicitOctalLarge',
        'hexLarge',
        'hexUpperLarge',
        'binaryLarge',
        'binaryUpperLarge',
      ].map((name) => ({
        linkArgs: [`-Wl,@${responses[name]}`],
        expected: 'stack-size=16777216',
        preserved: [`@${responses[name]}`],
      })),
      {
        linkArgs: [`-Wl,@${responses.leadingOctalSmall}`],
        expected: 'stack-size=8388608',
        preserved: [`@${responses.leadingOctalSmall}`],
      },
      ...[
        '16777216z',
        '08',
        '0o8',
        '0xg',
        '0b2',
      ].map((value) => ({
        linkArgs: [`-Wl,-z,stack-size=${value}`],
        expected: 'stack-size=8388608',
        preserved: [`stack-size=${value}`],
      })),
      ...[
        'invalidDecimal',
        'invalidOctal',
        'invalidExplicitOctal',
        'invalidHex',
        'invalidBinary',
      ].map((name) => ({
        linkArgs: [`-Wl,@${responses[name]}`],
        expected: 'stack-size=8388608',
        preserved: [`@${responses[name]}`],
      })),
      {
        linkArgs: ['-Wl,stack-size=33554432'],
        expected: 'stack-size=8388608',
        preserved: ['stack-size=33554432'],
      },
      {
        linkArgs: ['-Wl,-z=stack-size=33554432'],
        expected: 'stack-size=8388608',
        preserved: ['-z=stack-size=33554432'],
      },
      {
        linkArgs: ['-Xlinker', 'not-stack-size=33554432.o'],
        expected: 'stack-size=8388608',
        preserved: ['not-stack-size=33554432.o'],
      },
      {
        linkArgs: ['-Wl,-z,-zstack-size=33554432'],
        expected: 'stack-size=8388608',
        preserved: ['-z', '-zstack-size=33554432'],
      },
    ];

    for (const { linkArgs, expected, preserved } of cases) {
      execFileSync('bash', [nativeCc, source, ...linkArgs, '-o', join(root, 'out.wasm')], {
        cwd: root,
        env,
      });
      const emitted = readFileSync(capture, 'utf8').trim().split('\n');
      expect(emitted.filter((arg) => arg.startsWith('stack-size=')).at(-1)).toBe(expected);
      for (const arg of preserved ?? []) expect(emitted).toContain(arg);
    }

    for (const [name, value] of Object.entries(responseValues)) {
      expect(readFileSync(responses[name], 'utf8')).toBe(`-z\nstack-size=${value}\n`);
    }
    expect(readFileSync(nestedResponse, 'utf8')).toBe("-z 'stack-size=0x1000000'\n");
    expect(readFileSync(outerResponse, 'utf8')).toContain('not-stack-size=33554432.o');
    expect(readFileSync(clangResponse, 'utf8'))
      .toBe('-Xlinker -z -Xlinker stack-size=0x1000000\n');

    for (const linkArgs of [
      ['-Wl,-z,stack-size=1073741825'],
      ['-Wl,-zstack-size=1073741825'],
      ['-Xlinker', '-z', '-Xlinker', 'stack-size=1073741825'],
      [`-Wl,@${responses.overflowHex}`],
    ]) {
      expect(() => execFileSync(
        'bash',
        [nativeCc, source, ...linkArgs, '-o', join(root, 'overflow.wasm')],
        { cwd: root, env, stdio: 'pipe' },
      )).toThrow(/exceeds the SDK's 1073741824-byte executable memory limit/);
    }

    const utf16Little = join(root, 'utf16-le.rsp');
    const utf16Big = join(root, 'utf16-be.rsp');
    const utf16Contents = '-z\nstack-size=16777216\n';
    writeFileSync(utf16Little, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(utf16Contents, 'utf16le'),
    ]));
    const bigEndianContents = Buffer.from(utf16Contents, 'utf16le');
    bigEndianContents.swap16();
    writeFileSync(utf16Big, Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      bigEndianContents,
    ]));

    for (const linkArgs of [
      [`@${utf16Little}`],
      [`-Wl,@${utf16Big}`],
    ]) {
      rmSync(capture, { force: true });
      expect(() => execFileSync(
        'bash',
        [nativeCc, source, ...linkArgs, '-o', join(root, 'utf16.wasm')],
        { cwd: root, env, stdio: 'pipe' },
      )).toThrow(/UTF-16 response file .* is unsupported .* rewrite it as UTF-8/);
      expect(existsSync(capture)).toBe(false);
    }

    const cycleA = join(root, 'cycle-a.rsp');
    const cycleB = join(root, 'cycle-b.rsp');
    const aliasSource = join(root, 'alias-source.rsp');
    const aliasLink = join(root, 'alias-link.rsp');
    writeFileSync(cycleA, `@${cycleB}\n`);
    writeFileSync(cycleB, `@${cycleA}\n`);
    writeFileSync(aliasSource, `@${aliasLink}\n`);
    symlinkSync(aliasSource, aliasLink);
    for (const { linkArg, message } of [
      { linkArg: `-Wl,@${cycleA}`, message: /recursive response file/ },
      { linkArg: `-Wl,@${aliasSource}`, message: /recursive response file/ },
      { linkArg: `-Wl,@${join(root, 'missing.rsp')}`, message: /cannot inspect response file/ },
    ]) {
      rmSync(capture, { force: true });
      expect(() => execFileSync(
        'bash',
        [nativeCc, source, linkArg, '-o', join(root, 'rejected-response.wasm')],
        { cwd: root, env, stdio: 'pipe' },
      )).toThrow(message);
      expect(existsSync(capture)).toBe(false);
    }

    for (const traceMode of ['foreign', 'duplicate']) {
      rmSync(capture, { force: true });
      expect(() => execFileSync(
        'bash',
        [nativeCc, source, '-o', join(root, 'rejected-trace.wasm')],
        {
          cwd: root,
          env: { ...env, WASM_POSIX_TEST_TRACE_MODE: traceMode },
          stdio: 'pipe',
        },
      )).toThrow(/expected exactly one/);
      expect(existsSync(capture)).toBe(false);
    }
  }, 30_000);

  it('retains an interleaved larger request in a real LLVM link', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kandelo-native-cc-real-'));
    tempDirs.push(root);
    const toolchain = await resolveToolchain();
    const glueObjects = join(root, 'glue-objects');
    const source = join(root, 'main.c');
    const floorOutput = join(root, 'floor.wasm');
    const largeOutput = join(root, 'large.wasm');
    const deepOutput = join(root, 'deep.wasm');
    const deepResponses = Array.from({ length: 100 }, (_, index) =>
      join(root, `deep-${index}.rsp`));
    mkdirSync(glueObjects);
    writeFileSync(source, 'int main(void) { return 0; }\n');
    for (let index = 0; index < deepResponses.length; index++) {
      writeFileSync(
        deepResponses[index],
        index === deepResponses.length - 1
          ? '-z stack-size=16777216\n'
          : `@${deepResponses[index + 1]}\n`,
      );
    }

    for (const name of ['channel_syscall', 'compiler_rt', 'cxxrt']) {
      const output = join(glueObjects, `${name}.o`);
      execFileSync(toolchain.cc, buildClangArgs([
        '-c', join(toolchain.glueDir, `${name}.c`), '-o', output,
      ], toolchain), { stdio: 'pipe' });
    }

    const env = {
      ...process.env,
      WASM_POSIX_GLUE_DIR: toolchain.glueDir,
      WASM_POSIX_GLUE_OBJ_DIR: glueObjects,
      WASM_POSIX_LLVM_DIR: toolchain.llvmDir,
      WASM_POSIX_SYSROOT: toolchain.sysroot,
    };
    const invoke = (args: string[]): void => {
      execFileSync('bash', [nativeCc, '--kandelo-thread-slots=-1', source, ...args], {
        cwd: root,
        env,
        stdio: 'pipe',
      });
    };
    const stackPointer = (path: string): number => {
      const dump = execFileSync('wasm-objdump', ['-x', path], { encoding: 'utf8' });
      const match = dump.match(/<__stack_pointer> - init i32=(\d+)/);
      expect(match, dump).not.toBeNull();
      return Number(match?.[1]);
    };

    invoke(['-o', floorOutput]);
    invoke([
      '-Wl,-z', '-O2', '-g', '-fvisibility=hidden',
      '-Wl,stack-size=16777216', '-o', largeOutput,
    ]);
    invoke([`-Wl,@${deepResponses[0]}`, '-o', deepOutput]);

    expect(stackPointer(largeOutput) - stackPointer(floorOutput))
      .toBe(8 * 1024 * 1024);
    expect(stackPointer(deepOutput)).toBe(stackPointer(largeOutput));
  }, 30_000);

  it('preserves real Clang non-linking modes directly and through response files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kandelo-native-cc-no-link-'));
    tempDirs.push(root);
    const toolchain = await resolveToolchain();
    const source = join(root, 'non-link-mode.c');
    const modes = [
      ['syntax-only', '-fsyntax-only'],
      ['dependencies', '-M'],
      ['user-dependencies', '-MM'],
      ['analyze', '--analyze'],
    ] as const;
    writeFileSync(source, 'int square(int value) { return value * value; }\n');
    const env = {
      ...process.env,
      WASM_POSIX_GLUE_DIR: toolchain.glueDir,
      WASM_POSIX_GLUE_OBJ_DIR: join(root, 'unused-glue-objects'),
      WASM_POSIX_LLVM_DIR: toolchain.llvmDir,
      WASM_POSIX_SYSROOT: toolchain.sysroot,
    };

    for (const [name, mode] of modes) {
      const response = join(root, `${name}.rsp`);
      const directOutput = join(root, `${name}-direct.out`);
      const responseOutput = join(root, `${name}-response.out`);
      writeFileSync(response, `${mode} "${source}" -o "${responseOutput}"\n`);
      for (const args of [
        [mode, source, '-o', directOutput],
        [`@${response}`],
      ]) {
        execFileSync('bash', [nativeCc, ...args], {
          cwd: root,
          env,
          stdio: 'pipe',
        });
      }
    }
    expect(existsSync(join(root, 'a.out'))).toBe(false);
  }, 30_000);
});
