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

  const args: string[] = [
    ...COMPILE_FLAGS,
    `--sysroot=${toolchain.sysroot}`,
  ];

  if (parsed.compileOnly) args.push('-c');
  if (parsed.preprocessOnly) args.push('-E');
  if (parsed.assemblyOnly) args.push('-S');
  if (parsed.outputFile) args.push('-o', parsed.outputFile);
  args.push(...parsed.otherArgs);

  args.push(...parsed.sourceFiles);
  args.push(...parsed.objectFiles);
  args.push(...parsed.archiveFiles);

  if (needsLinking(parsed)) {
    args.push(
      join(toolchain.glueDir, 'syscall_glue.c'),
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
