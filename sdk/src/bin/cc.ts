#!/usr/bin/env -S node --experimental-strip-types
import { join } from 'node:path';
import { resolveToolchain, type Toolchain } from '../lib/toolchain.ts';
import { compileFlags, linkFlags, SHARED_LINK_FLAGS, filterArgs, parseArgs, needsLinking } from '../lib/flags.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';
import { type WasmArch, detectArch, targetTriple } from '../lib/arch.ts';

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

  args.push(...parsed.sourceFiles);
  args.push(...parsed.objectFiles);
  args.push(...parsed.archiveFiles);

  if (linking) {
    if (parsed.shared) {
      // Shared library build: no CRT, no libc, no syscall glue
      if (parsed.pic) args.push('-fPIC');
      args.push(...SHARED_LINK_FLAGS);
    } else {
      // Executable build: link CRT, libc, and syscall glue
      args.push(
        join(toolchain.glueDir, 'channel_syscall.c'),
        join(toolchain.glueDir, 'compiler_rt.c'),
      );
      if (parsed.linkDl) {
        args.push(join(toolchain.glueDir, 'dlopen.c'));
      }
      args.push(
        join(toolchain.sysroot, 'lib', 'crt1.o'),
        join(toolchain.sysroot, 'lib', 'libc.a'),
        ...linkFlags(arch),
      );
    }
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
