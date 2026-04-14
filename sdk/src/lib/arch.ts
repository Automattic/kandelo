import { basename } from 'node:path';

export type WasmArch = 'wasm32' | 'wasm64';

/**
 * Detect target architecture from the invocation name.
 * If invoked as wasm64posix-*, returns 'wasm64'. Otherwise 'wasm32'.
 */
export function detectArch(): WasmArch {
  const invoked = basename(process.argv[1] ?? '');
  if (invoked.startsWith('wasm64posix-')) return 'wasm64';
  return 'wasm32';
}

export function targetTriple(arch: WasmArch): string {
  return `${arch}-unknown-unknown`;
}

export function hostTriple(arch: WasmArch): string {
  return `${arch}-unknown-none`;
}

export function toolPrefix(arch: WasmArch): string {
  return `${arch}posix`;
}

export function sysrootDir(arch: WasmArch): string {
  return arch === 'wasm64' ? 'sysroot64' : 'sysroot';
}
