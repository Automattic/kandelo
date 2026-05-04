import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './exec.ts';
import { type WasmArch, sysrootDir } from './arch.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SDK_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(SDK_ROOT, '..');

export interface Toolchain {
  llvmDir: string;
  cc: string;
  cxx: string;
  ar: string;
  ranlib: string;
  nm: string;
  sysroot: string;
  glueDir: string;
}

const HOMEBREW_LLVM = '/opt/homebrew/opt/llvm/bin';

export async function findLlvmDir(): Promise<string> {
  // 1. Project-specific override — highest priority.
  const envDir = process.env.WASM_POSIX_LLVM_DIR;
  if (envDir) {
    if (existsSync(join(envDir, 'clang'))) return envDir;
    throw new Error(`WASM_POSIX_LLVM_DIR="${envDir}" does not contain clang`);
  }

  // 2. The Nix flake's shellHook exports LLVM_BIN (=${llvmTree}/bin) so
  //    that build scripts can call $LLVM_BIN/clang directly. Honor it
  //    here so wasm32posix-cc resolves to the same toolchain — without
  //    this, the discovery fallback below would silently pick a system
  //    clang from /usr/lib/llvm-* on Ubuntu CI (older version, missing
  //    -wasm-use-legacy-eh=true and other modern wasm flags). LLVM_PREFIX
  //    is the same tree, just the parent — accept either.
  const llvmBin = process.env.LLVM_BIN;
  if (llvmBin && existsSync(join(llvmBin, 'clang'))) return llvmBin;
  const llvmPrefix = process.env.LLVM_PREFIX;
  if (llvmPrefix && existsSync(join(llvmPrefix, 'bin', 'clang'))) {
    return join(llvmPrefix, 'bin');
  }

  // 3. Check if clang on PATH supports wasm32
  const pathResult = await run('which', ['clang']);
  if (pathResult.exitCode === 0) {
    const clangPath = pathResult.stdout.trim();
    const testResult = await run(clangPath, [
      '--target=wasm32-unknown-unknown', '-x', 'c', '-c', '-o', '/dev/null', '/dev/null',
    ]);
    if (testResult.exitCode === 0) {
      return dirname(clangPath);
    }
  }

  // macOS Homebrew LLVM
  if (existsSync(join(HOMEBREW_LLVM, 'clang'))) return HOMEBREW_LLVM;

  // Linux: scan /usr/lib/llvm-* for highest version
  try {
    const parent = '/usr/lib';
    const entries = readdirSync(parent).filter(e => e.startsWith('llvm-')).sort();
    for (const entry of entries.reverse()) {
      const binDir = join(parent, entry, 'bin');
      if (existsSync(join(binDir, 'clang'))) return binDir;
    }
  } catch {
    // /usr/lib may not exist
  }

  throw new Error(
    'Could not find a wasm32-capable LLVM/clang installation.\n' +
    'Install LLVM via:\n' +
    '  macOS:  brew install llvm\n' +
    '  Ubuntu: apt install llvm clang lld\n' +
    'Or set WASM_POSIX_LLVM_DIR to your LLVM bin directory.'
  );
}

export function findSysroot(arch: WasmArch = 'wasm32'): string {
  const envSysroot = process.env.WASM_POSIX_SYSROOT;
  if (envSysroot) return envSysroot;
  return resolve(REPO_ROOT, sysrootDir(arch));
}

export function validateSysroot(sysroot: string): void {
  if (!existsSync(join(sysroot, 'lib', 'libc.a'))) {
    throw new Error(
      `Sysroot not found at ${sysroot}\n` +
      'Run scripts/build-musl.sh first.'
    );
  }
}

export function findGlueDir(): string {
  const envGlue = process.env.WASM_POSIX_GLUE_DIR;
  if (envGlue) return envGlue;
  return resolve(REPO_ROOT, 'glue');
}

export async function resolveToolchain(arch: WasmArch = 'wasm32'): Promise<Toolchain> {
  const llvmDir = await findLlvmDir();
  const sysroot = findSysroot(arch);
  const glueDir = findGlueDir();

  validateSysroot(sysroot);

  return {
    llvmDir,
    cc: join(llvmDir, 'clang'),
    cxx: join(llvmDir, 'clang++'),
    ar: join(llvmDir, 'llvm-ar'),
    ranlib: join(llvmDir, 'llvm-ranlib'),
    nm: join(llvmDir, 'llvm-nm'),
    sysroot,
    glueDir,
  };
}
