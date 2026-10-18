#!/usr/bin/env -S node --experimental-strip-types
import { findSysroot } from '../lib/toolchain.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';
import { detectArch } from '../lib/arch.ts';

// PKG_CONFIG_PATH is honored from the caller's environment so build scripts
// can point pkg-config at dep-cache .pc files (e.g.
// ~/.cache/kandelo/libs/<name>-<v>-rev<N>-<sha>/lib/pkgconfig).
// We FILTER it to kandelo paths only — Nix's pkg-config-wrapper
// auto-populates PKG_CONFIG_PATH with host buildInputs' .pc dirs (host
// openssl, libidn2, krb5, etc.), and those would override the wasm32
// dep flags we set via env vars (OPENSSL_CFLAGS=…). Without filtering,
// libcurl's configure runs `pkg-config --libs openssl` and gets host
// openssl back, then wasm-ld fails to link `/nix/store/.../openssl.so`
// against a wasm32 conftest.
//
// PKG_CONFIG_SYSROOT_DIR is intentionally NOT set: every .pc file we
// produce (sysroot-installed and dep-cache alike) has absolute host paths
// in `prefix=`, so prepending sysroot would corrupt the emitted -I/-L
// flags rather than resolve them.
export function buildPkgConfigEnv(
  callerEnv: NodeJS.ProcessEnv,
  sysroot: string,
): Record<string, string | undefined> {
  const callerPath = callerEnv.PKG_CONFIG_PATH ?? '';
  // The resolver already knows the answer, so ask it instead of guessing from
  // the spelling. `WASM_POSIX_DEP_PKG_CONFIG_PATH` is set per build script
  // (`build_deps.rs`) to the colon-joined pkgconfig directory of every
  // dependency it installed for THIS package. A path in that list is
  // wasm32/64-targeted by provenance -- the resolver put it there -- whatever
  // the cache root happens to be called.
  //
  // Without this, the name test below is the only gate, and it is a test on a
  // STRING: `p.includes('kandelo/')` holds for `~/.cache/kandelo/...` and fails
  // for `~/.cache/kandelo-lane-f/...`, because "kandelo" is followed by "-"
  // rather than "/". Every per-worktree cache root is spelled that way, so in
  // those trees the filter silently emptied PKG_CONFIG_PATH and php's configure
  // reported `No package 'icu-uc' found` while all three icu .pc files sat
  // exactly where the build script pointed. Fixing it here fixes it for every
  // package at once; no build script changes.
  const resolverProvided = new Set(
    (callerEnv.WASM_POSIX_DEP_PKG_CONFIG_PATH ?? '')
      .split(':')
      .filter((p) => p !== ''),
  );
  const filtered = callerPath
    .split(':')
    .filter((p) => p === '' ? false : isWasmPosixPath(p) || resolverProvided.has(p))
    .join(':');
  return {
    ...callerEnv,
    PKG_CONFIG_LIBDIR: `${sysroot}/lib/pkgconfig:${sysroot}/share/pkgconfig`,
    PKG_CONFIG_PATH: filtered,
  };
}

/** True if the path is part of the kandelo cache or sysroot.
 * Anything under `kandelo/...` (the dep cache root used by
 * `~/.cache/kandelo/libs/<name>...`) or under `sysroot`/
 * `sysroot64` is wasm32/64 targeted; everything else is host-targeted
 * (Nix-store host pc files, /usr/lib/pkgconfig, etc.) and gets dropped. */
function isWasmPosixPath(p: string): boolean {
  return (
    p.includes('kandelo/') ||
    p.includes('/sysroot/') ||
    p.includes('/sysroot64/') ||
    p.endsWith('/sysroot/lib/pkgconfig') ||
    p.endsWith('/sysroot64/lib/pkgconfig')
  );
}

async function main(): Promise<void> {
  const arch = detectArch();
  const sysroot = findSysroot(arch);
  const env = buildPkgConfigEnv(process.env, sysroot);
  const exitCode = await runPassthrough('pkg-config', process.argv.slice(2), env);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
