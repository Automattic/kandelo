#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveToolchain, type Toolchain } from '../lib/toolchain.ts';
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

export function buildClangArgs(userArgs: string[], toolchain: Toolchain, arch: WasmArch = 'wasm32'): string[] {
  const { filtered, warnings } = filterArgs(userArgs, arch);
  for (const w of warnings) console.error(w);

  const parsed = parseArgs(filtered);
  const linking = needsLinking(parsed);
  const hasSourceFiles = parsed.sourceFiles.length > 0;
  const forwardedArgs: string[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const arg = filtered[i];
    if (arg === '-shared' || arg === '-ldl') continue;
    if (arg === '--kandelo-thread-slots' || arg === '--wasm-posix-thread-slots') {
      i++;
      continue;
    }
    if (arg.startsWith('--kandelo-thread-slots=') || arg.startsWith('--wasm-posix-thread-slots=')) continue;
    forwardedArgs.push(arg);
  }

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

  if (linking) {
    if (parsed.shared) {
      // Shared library build: no CRT, no libc, no syscall glue
      args.push(...forwardedArgs, ...SHARED_LINK_FLAGS);
    } else {
      // Executable build: resolve user libraries after the platform glue that
      // overrides musl symbols, then make the final libc archive available for
      // everything still unresolved. Preserve the user's link-input order.
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
        ...forwardedArgs,
        join(toolchain.sysroot, 'lib', 'libc.a'),
        ...linkFlags(arch),
      );
    }
  } else {
    args.push(...forwardedArgs);
  }

  return args;
}

async function main(): Promise<void> {
  const arch = detectArch();
  const toolchain = await resolveToolchain(arch);
  const args = buildClangArgs(process.argv.slice(2), toolchain, arch);
  const exitCode = await runPassthrough(toolchain.cc, args);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
