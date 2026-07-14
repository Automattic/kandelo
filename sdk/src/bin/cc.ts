#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLldMajor, resolveToolchain, type Toolchain } from '../lib/toolchain.ts';
import {
  compileFlags,
  filterArgs,
  inferThreadSlotDeclaration,
  linkFlags,
  needsLinking,
  parseArgs,
  SHARED_LINK_FLAGS,
  THREAD_SLOT_USE_HOST_DEFAULT,
  threadSlotDeclarationDefine,
} from '../lib/flags.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';
import { type WasmArch, detectArch, targetTriple } from '../lib/arch.ts';

const STABLE_SDK_SOURCE_ROOT = '/usr/src/kandelo-sdk';

function sourcePrefixMapFlags(source: string, destination: string): string[] {
  return [
    `-ffile-prefix-map=${source}=${destination}`,
    `-fdebug-prefix-map=${source}=${destination}`,
    `-fmacro-prefix-map=${source}=${destination}`,
  ];
}

function sdkSourcePrefixMapFlags(toolchain: Toolchain, arch: WasmArch): string[] {
  const sysrootName = arch === 'wasm64' ? 'sysroot64' : 'sysroot';
  return [
    ...sourcePrefixMapFlags(toolchain.glueDir, `${STABLE_SDK_SOURCE_ROOT}/libc/glue`),
    ...sourcePrefixMapFlags(toolchain.sysroot, `${STABLE_SDK_SOURCE_ROOT}/${sysrootName}`),
  ];
}

export function buildClangArgs(userArgs: string[], toolchain: Toolchain, arch: WasmArch = 'wasm32'): string[] {
  const { filtered, warnings } = filterArgs(userArgs, arch);
  for (const w of warnings) console.error(w);

  const parsed = parseArgs(filtered);
  const linking = needsLinking(parsed);
  const hasSourceFiles = parsed.sourceFiles.length > 0;

  const args: string[] = [];
  const target = `--target=${targetTriple(arch)}`;

  // Inject compile flags when there are source files, compile-only modes,
  // or when linking (since the glue .c file needs them).
  if (hasSourceFiles || parsed.compileOnly || parsed.preprocessOnly || parsed.assemblyOnly || linking) {
    args.push(...compileFlags(arch));
  }
  // Target is always needed (even for link-only, clang needs to know the target)
  if (!args.includes(target)) {
    args.push(target);
  }
  args.push(`--sysroot=${toolchain.sysroot}`);

  if (parsed.compileOnly) args.push('-c');
  if (parsed.preprocessOnly) args.push('-E');
  if (parsed.assemblyOnly) args.push('-S');
  if (parsed.outputFile) args.push('-o', parsed.outputFile);
  args.push(...parsed.otherArgs);

  // The SDK compiles its glue sources during each executable link. Keep those
  // files and sysroot headers independent of the checkout used for the build.
  // Append these after caller flags so a broader caller-owned mapping cannot
  // retain a less-specific host path in DWARF.
  if (hasSourceFiles || parsed.compileOnly || parsed.preprocessOnly || parsed.assemblyOnly || linking) {
    args.push(...sdkSourcePrefixMapFlags(toolchain, arch));
  }

  args.push(...parsed.sourceFiles);
  args.push(...parsed.objectFiles);
  args.push(...parsed.archiveFiles);

  // -fPIC is consumed by parseArgs (so the linker can see `parsed.pic`),
  // but it must also reach clang at compile time so the resulting object
  // uses PIC relocations. Without this a TU later linked into a shared
  // library produces non-PIC objects and `wasm-ld --shared` rejects them
  // with "R_WASM_MEMORY_ADDR_LEB cannot be used; recompile with -fPIC".
  if (parsed.pic) args.push('-fPIC');

  if (linking) {
    // Keep clang and lld in the same resolved LLVM tree. Without an explicit
    // linker path, clang can pick an unrelated ambient wasm-ld whose defaults
    // differ from the repository-pinned toolchain.
    args.push(`-fuse-ld=${join(toolchain.llvmDir, 'wasm-ld')}`);
    if (parsed.shared) {
      // Shared library build: no CRT, no libc, no syscall glue
      args.push(...SHARED_LINK_FLAGS);
    } else {
      if (toolchain.lldMajor === null) {
        throw new Error(
          'wasm-ld version is unresolved; call prepareExecutableLinker() before building executable link arguments',
        );
      }
      // Executable build: link CRT, libc, and syscall glue
      const threadSlots = inferThreadSlotDeclaration(parsed, userArgs, {
        readFile: (path) => {
          try {
            return readFileSync(path, 'utf8');
          } catch {
            return null;
          }
        },
      });
      if (threadSlots !== THREAD_SLOT_USE_HOST_DEFAULT) {
        args.push(threadSlotDeclarationDefine(threadSlots));
      }
      args.push(
        join(toolchain.glueDir, 'channel_syscall.c'),
        join(toolchain.glueDir, 'compiler_rt.c'),
        join(toolchain.glueDir, 'cxxrt.c'),
      );
      if (parsed.linkDl) {
        args.push(join(toolchain.glueDir, 'dlopen.c'));
      }
      args.push(
        join(toolchain.sysroot, 'lib', 'crt1.o'),
        join(toolchain.sysroot, 'lib', 'libc.a'),
        // LLD 22 made --stack-first the default; LLD 21 neither defaults to
        // it nor accepts --no-stack-first. Preserve Kandelo's established
        // stack-after-data layout explicitly only where the option exists.
        ...(toolchain.lldMajor >= 22 ? ['-Wl,--no-stack-first'] : []),
        ...linkFlags(arch),
      );
    }
  }

  return args;
}

export async function prepareExecutableLinker(
  userArgs: string[],
  toolchain: Toolchain,
  arch: WasmArch = 'wasm32',
): Promise<void> {
  const { filtered } = filterArgs(userArgs, arch);
  const parsed = parseArgs(filtered);
  if (needsLinking(parsed) && !parsed.shared) {
    toolchain.lldMajor = await resolveLldMajor(toolchain.llvmDir);
  }
}

async function main(): Promise<void> {
  const arch = detectArch();
  const toolchain = await resolveToolchain(arch);
  const userArgs = process.argv.slice(2);
  await prepareExecutableLinker(userArgs, toolchain, arch);
  const args = buildClangArgs(userArgs, toolchain, arch);
  const exitCode = await runPassthrough(toolchain.cc, args);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
