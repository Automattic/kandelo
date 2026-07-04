#!/usr/bin/env -S node --experimental-strip-types
import { resolveToolchain } from '../lib/toolchain.ts';
import { buildClangArgs, prepareExecutableLinker } from './cc.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';
import { detectArch } from '../lib/arch.ts';

async function main(): Promise<void> {
  const arch = detectArch();
  const toolchain = await resolveToolchain(arch);
  const userArgs = process.argv.slice(2);
  const executableLinker = await prepareExecutableLinker(
    userArgs,
    toolchain,
    arch,
    toolchain.cxx,
  );
  const args = buildClangArgs(userArgs, toolchain, arch, executableLinker ?? undefined);
  const exitCode = await runPassthrough(toolchain.cxx, args);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
