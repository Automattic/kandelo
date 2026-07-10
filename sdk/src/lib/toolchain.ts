import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './exec.ts';
import { type WasmArch, sysrootDir } from './arch.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SDK_ROOT = resolve(__dirname, '../..');
const SDK_REPO_ROOT = resolve(SDK_ROOT, '..');

// Walk up from cwd because npm-link makes SDK_REPO_ROOT resolve to whichever worktree was linked, not the user's cwd.
function findProjectRoot(): string | null {
  let dir = resolve(process.cwd());
  while (true) {
    if (existsSync(join(dir, 'libc', 'glue', 'abi_constants.h'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function projectRootOrSdk(): string {
  const projectRoot = findProjectRoot();
  if (projectRoot) return projectRoot;
  if (existsSync(join(SDK_ROOT, 'glue', 'abi_constants.h'))) return SDK_ROOT;
  return SDK_REPO_ROOT;
}

export interface Toolchain {
  llvmDir: string;
  lldMajor: number | null;
  cc: string;
  cxx: string;
  ar: string;
  ranlib: string;
  nm: string;
  sysroot: string;
  glueDir: string;
}

const HOMEBREW_LLVM = '/opt/homebrew/opt/llvm/bin';
const REQUIRED_LLVM_TOOLS = ['clang', 'clang++', 'llvm-ar', 'llvm-ranlib', 'llvm-nm', 'wasm-ld'];

function hasRequiredLlvmTools(binDir: string): boolean {
  return REQUIRED_LLVM_TOOLS.every(tool => existsSync(join(binDir, tool)));
}

export async function findLlvmDir(): Promise<string> {
  // 1. Project-specific override — highest priority.
  const envDir = process.env.WASM_POSIX_LLVM_DIR;
  if (envDir) {
    if (hasRequiredLlvmTools(envDir)) return envDir;
    throw new Error(
      `WASM_POSIX_LLVM_DIR="${envDir}" does not contain the required LLVM tools: ` +
      REQUIRED_LLVM_TOOLS.join(', ')
    );
  }

  // 2. The Nix flake's shellHook exports LLVM_BIN (=${llvmTree}/bin) so
  //    that build scripts can call $LLVM_BIN/clang directly. Honor it
  //    here so wasm32posix-cc resolves to the same toolchain — without
  //    this, the discovery fallback below would silently pick a system
  //    clang from /usr/lib/llvm-* on Ubuntu CI (older version, missing
  //    -wasm-use-legacy-eh=true and other modern wasm flags). LLVM_PREFIX
  //    is the same tree, just the parent — accept either.
  const llvmBin = process.env.LLVM_BIN;
  if (llvmBin && hasRequiredLlvmTools(llvmBin)) return llvmBin;
  const llvmPrefix = process.env.LLVM_PREFIX;
  if (llvmPrefix && hasRequiredLlvmTools(join(llvmPrefix, 'bin'))) {
    return join(llvmPrefix, 'bin');
  }

  // 3. Check PATH for a complete LLVM bin directory. Some Nix clang packages
  // put clang-wrapper or clang-unwrapped before our combined llvmTree, so
  // `which clang` may find a clang-only directory even though a later PATH
  // entry has clang + wasm-ld + llvm-* together.
  const pathDirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  const seenPathDirs = new Set<string>();
  for (const clangDir of pathDirs) {
    if (seenPathDirs.has(clangDir)) continue;
    seenPathDirs.add(clangDir);
    if (hasRequiredLlvmTools(clangDir)) {
      const testResult = await run(join(clangDir, 'clang'), [
        '--target=wasm32-unknown-unknown', '-x', 'c', '-c', '-o', '/dev/null', '/dev/null',
      ]);
      if (testResult.exitCode === 0) {
        return clangDir;
      }
    }
  }

  // macOS Homebrew LLVM
  if (hasRequiredLlvmTools(HOMEBREW_LLVM)) return HOMEBREW_LLVM;

  // Linux: scan /usr/lib/llvm-* for highest version
  try {
    const parent = '/usr/lib';
    const entries = readdirSync(parent).filter(e => e.startsWith('llvm-')).sort();
    for (const entry of entries.reverse()) {
      const binDir = join(parent, entry, 'bin');
      if (hasRequiredLlvmTools(binDir)) return binDir;
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
  return resolve(projectRootOrSdk(), sysrootDir(arch));
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
  return resolve(projectRootOrSdk(), 'libc', 'glue');
}

export async function resolveLldMajor(llvmDir: string): Promise<number> {
  const result = await run(join(llvmDir, 'wasm-ld'), ['--version']);
  const match = `${result.stdout}\n${result.stderr}`.match(/\bLLD\s+(\d+)/i);
  if (result.exitCode !== 0 || !match) {
    throw new Error(`Could not determine wasm-ld version in ${llvmDir}`);
  }
  return Number(match[1]);
}

export async function resolveToolchain(arch: WasmArch = 'wasm32'): Promise<Toolchain> {
  const llvmDir = await findLlvmDir();
  const sysroot = findSysroot(arch);
  const glueDir = findGlueDir();

  validateSysroot(sysroot);

  return {
    llvmDir,
    lldMajor: null,
    cc: join(llvmDir, 'clang'),
    cxx: join(llvmDir, 'clang++'),
    ar: join(llvmDir, 'llvm-ar'),
    ranlib: join(llvmDir, 'llvm-ranlib'),
    nm: join(llvmDir, 'llvm-nm'),
    sysroot,
    glueDir,
  };
}
