#!/usr/bin/env -S node --experimental-strip-types
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';
import { type WasmArch, detectArch, hostTriple, toolPrefix } from '../lib/arch.ts';

const __configure_filename = fileURLToPath(import.meta.url);
const SDK_ROOT = resolve(dirname(__configure_filename), '../..');

export function buildConfigureEnv(arch: WasmArch = 'wasm32'): Record<string, string> {
  const prefix = toolPrefix(arch);

  // config.site provides cross-compilation cache variables for autoconf.
  // User-exported CONFIG_SITE takes precedence.
  let configSite = process.env.CONFIG_SITE ?? '';
  if (!configSite) {
    const defaultSite = resolve(SDK_ROOT, 'config.site');
    if (existsSync(defaultSite)) {
      configSite = defaultSite;
    }
  }

  return {
    ...process.env as Record<string, string>,
    CC: `${prefix}-cc`,
    CXX: `${prefix}-c++`,
    AR: `${prefix}-ar`,
    RANLIB: `${prefix}-ranlib`,
    NM: `${prefix}-nm`,
    STRIP: `${prefix}-strip`,
    PKG_CONFIG: `${prefix}-pkg-config`,
    CFLAGS: process.env.CFLAGS ?? '',
    CXXFLAGS: process.env.CXXFLAGS ?? '',
    LDFLAGS: process.env.LDFLAGS ?? '',
    ...(configSite ? { CONFIG_SITE: configSite } : {}),
  };
}

export function buildConfigureArgs(userArgs: string[], arch: WasmArch = 'wasm32'): string[] {
  return [
    `--host=${hostTriple(arch)}`,
    '--prefix=/usr',
    ...userArgs,
  ];
}

async function main(): Promise<void> {
  const arch = detectArch();
  const args = buildConfigureArgs(process.argv.slice(2), arch);
  const env = buildConfigureEnv(arch);
  const exitCode = await runPassthrough('./configure', args, env);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
