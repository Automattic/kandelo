#!/usr/bin/env -S node --experimental-strip-types
import { runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';

export function buildConfigureEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    CC: 'wasm32posix-cc',
    CXX: 'wasm32posix-c++',
    AR: 'wasm32posix-ar',
    RANLIB: 'wasm32posix-ranlib',
    NM: 'wasm32posix-nm',
    STRIP: 'wasm32posix-strip',
    PKG_CONFIG: 'wasm32posix-pkg-config',
    CFLAGS: process.env.CFLAGS ?? '',
    CXXFLAGS: process.env.CXXFLAGS ?? '',
    LDFLAGS: process.env.LDFLAGS ?? '',
  };
}

export function buildConfigureArgs(userArgs: string[]): string[] {
  return [
    '--host=wasm32-unknown-none',
    '--prefix=/usr',
    ...userArgs,
  ];
}

async function main(): Promise<void> {
  const args = buildConfigureArgs(process.argv.slice(2));
  const env = buildConfigureEnv();
  const exitCode = await runPassthrough('./configure', args, env);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
