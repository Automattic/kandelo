#!/usr/bin/env -S node --experimental-strip-types
import { resolveToolchain } from '../lib/toolchain.ts';
import { buildClangArgs } from './cc.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';
import { detectArch } from '../lib/arch.ts';

async function main(): Promise<void> {
  const arch = detectArch();
  const toolchain = await resolveToolchain(arch);
  const args = buildClangArgs(process.argv.slice(2), toolchain, arch);
  const exitCode = await runPassthrough(toolchain.cxx, args);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
