#!/usr/bin/env -S node --experimental-strip-types
import { join } from 'node:path';
import { resolveToolchain, type Toolchain } from '../lib/toolchain.ts';
import { COMPILE_FLAGS, LINK_FLAGS, filterArgs, parseArgs, needsLinking } from '../lib/flags.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';

export function buildClangArgs(userArgs: string[], toolchain: Toolchain): string[] {
  const { filtered, warnings } = filterArgs(userArgs);
  for (const w of warnings) console.error(w);

  const parsed = parseArgs(filtered);
  const linking = needsLinking(parsed);
  const hasSourceFiles = parsed.sourceFiles.length > 0;

  const args: string[] = [];

  // Inject compile flags when there are source files, compile-only modes,
  // or when linking (since the glue .c file needs them).
  if (hasSourceFiles || parsed.compileOnly || parsed.preprocessOnly || parsed.assemblyOnly || linking) {
    args.push(...COMPILE_FLAGS);
  }
  // Target is always needed (even for link-only, clang needs to know the target)
  if (!args.includes('--target=wasm32-unknown-unknown')) {
    args.push('--target=wasm32-unknown-unknown');
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
    args.push(
      join(toolchain.glueDir, 'channel_syscall.c'),
      join(toolchain.glueDir, 'compiler_rt.c'),
      join(toolchain.sysroot, 'lib', 'crt1.o'),
      join(toolchain.sysroot, 'lib', 'libc.a'),
      ...LINK_FLAGS,
    );
  }

  return args;
}

async function main(): Promise<void> {
  const toolchain = await resolveToolchain();
  const args = buildClangArgs(process.argv.slice(2), toolchain);
  const exitCode = await runPassthrough(toolchain.cc, args);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
