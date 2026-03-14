#!/usr/bin/env -S node --experimental-strip-types
import { findSysroot } from '../lib/toolchain.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';

async function main(): Promise<void> {
  const sysroot = findSysroot();
  const env = {
    ...process.env,
    PKG_CONFIG_SYSROOT_DIR: sysroot,
    PKG_CONFIG_LIBDIR: `${sysroot}/lib/pkgconfig:${sysroot}/share/pkgconfig`,
    PKG_CONFIG_PATH: '',
  };

  const exitCode = await runPassthrough('pkg-config', process.argv.slice(2), env);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
