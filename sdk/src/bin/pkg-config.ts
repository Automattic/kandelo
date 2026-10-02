#!/usr/bin/env -S node --experimental-strip-types
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { findSysroot } from '../lib/toolchain.ts';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';
import { detectArch, toolPrefix } from '../lib/arch.ts';

// PKG_CONFIG_PATH is honored from the caller's environment so build scripts
// can point pkg-config at their dependencies' .pc files. Only entries inside
// a target root survive: Nix's pkg-config-wrapper populates PKG_CONFIG_PATH
// with the dev shell's host libraries (openssl, libpng, zlib, ...), and
// pkg-config searches PKG_CONFIG_PATH in addition to PKG_CONFIG_LIBDIR, so a
// surviving host entry turns into -I/-L flags for host-built headers and
// libraries in a WebAssembly compile.
//
// Membership is decided against the roots the resolver hands every package
// build, not by path substrings: a substring test such as "contains
// kandelo/" also keeps any host directory below a checkout named kandelo.
//
// PKG_CONFIG_SYSROOT_DIR is intentionally NOT set: every .pc file we
// produce (sysroot-installed and dep-cache alike) has absolute host paths
// in `prefix=`, so prepending sysroot would corrupt the emitted -I/-L
// flags rather than resolve them.

/**
 * Directories whose .pc files describe WebAssembly artifacts: the target
 * sysroot, the resolver's compiled-package cache (every declared dependency
 * lives below it), and the running recipe's own work and output directories
 * (for .pc files a build stages for itself).
 */
export function targetPkgConfigRoots(env: NodeJS.ProcessEnv, sysroot: string): string[] {
  const roots = [sysroot];
  for (const name of [
    'WASM_POSIX_BINARY_CACHE_ROOT',
    'WASM_POSIX_DEP_WORK_DIR',
    'WASM_POSIX_DEP_OUT_DIR',
  ]) {
    const value = env[name];
    if (value && isAbsolute(value)) roots.push(value);
  }
  return roots;
}

function spellings(path: string): string[] {
  const lexical = resolve(path);
  try {
    const real = realpathSync(lexical);
    return real === lexical ? [lexical] : [lexical, real];
  } catch {
    return [lexical];
  }
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export interface PkgConfigPathFilter {
  kept: string[];
  dropped: string[];
}

export function filterPkgConfigPath(value: string, roots: string[]): PkgConfigPathFilter {
  const rootSpellings = roots.flatMap(spellings);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const entry of value.split(':')) {
    if (entry === '') continue;
    const member = isAbsolute(entry) &&
      spellings(entry).some((path) => rootSpellings.some((root) => inside(path, root)));
    (member ? kept : dropped).push(entry);
  }
  return { kept, dropped };
}

export interface PkgConfigEnv {
  env: Record<string, string | undefined>;
  dropped: string[];
}

export function buildPkgConfigEnv(
  callerEnv: NodeJS.ProcessEnv,
  sysroot: string,
): PkgConfigEnv {
  const { kept, dropped } = filterPkgConfigPath(
    callerEnv.PKG_CONFIG_PATH ?? '',
    targetPkgConfigRoots(callerEnv, sysroot),
  );
  return {
    env: {
      ...callerEnv,
      PKG_CONFIG_LIBDIR: `${sysroot}/lib/pkgconfig:${sysroot}/share/pkgconfig`,
      PKG_CONFIG_PATH: kept.join(':'),
    },
    dropped,
  };
}

export function droppedPathNote(tool: string, dropped: string[]): string | null {
  if (dropped.length === 0) return null;
  return `${tool}: ignored ${dropped.length} PKG_CONFIG_PATH ` +
    `entr${dropped.length === 1 ? 'y' : 'ies'} outside the sysroot, package cache, ` +
    `and build directories: ${dropped.join(':')}`;
}

async function main(): Promise<void> {
  const arch = detectArch();
  const sysroot = findSysroot(arch);
  const { env, dropped } = buildPkgConfigEnv(process.env, sysroot);
  const note = droppedPathNote(`${toolPrefix(arch)}-pkg-config`, dropped);
  if (note) console.error(note);
  const exitCode = await runPassthrough('pkg-config', process.argv.slice(2), env);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
