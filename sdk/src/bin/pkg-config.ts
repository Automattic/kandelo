#!/usr/bin/env -S node --experimental-strip-types
import { findSysroot } from '../lib/toolchain.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';
import { detectArch } from '../lib/arch.ts';

// PKG_CONFIG_PATH is honored from the caller's environment so build scripts
// can point pkg-config at dep-cache .pc files (e.g.
// ~/.cache/wasm-posix-kernel/libs/<name>-<v>-rev<N>-<sha>/lib/pkgconfig).
// PKG_CONFIG_SYSROOT_DIR is intentionally NOT set: every .pc file we
// produce (sysroot-installed and dep-cache alike) has absolute host paths
// in `prefix=`, so prepending sysroot would corrupt the emitted -I/-L
// flags rather than resolve them.
export function buildPkgConfigEnv(
  callerEnv: NodeJS.ProcessEnv,
  sysroot: string,
): Record<string, string | undefined> {
  return {
    ...callerEnv,
    PKG_CONFIG_LIBDIR: `${sysroot}/lib/pkgconfig:${sysroot}/share/pkgconfig`,
    PKG_CONFIG_PATH: callerEnv.PKG_CONFIG_PATH ?? '',
  };
}

async function main(): Promise<void> {
  const arch = detectArch();
  const sysroot = findSysroot(arch);
  const env = buildPkgConfigEnv(process.env, sysroot);
  const exitCode = await runPassthrough('pkg-config', process.argv.slice(2), env);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
