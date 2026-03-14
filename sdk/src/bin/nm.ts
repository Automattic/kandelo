#!/usr/bin/env -S node --experimental-strip-types
import { resolveToolchain } from '../lib/toolchain.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';

async function main(): Promise<void> {
  const toolchain = await resolveToolchain();
  const exitCode = await runPassthrough(toolchain.nm, process.argv.slice(2));
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
