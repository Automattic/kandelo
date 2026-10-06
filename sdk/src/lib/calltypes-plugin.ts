/**
 * The KandeloCallTypes compiler plugin (sdk/src/plugin/): locating, building
 * and caching it, and recognizing the facts it leaves in Wasm modules.
 *
 * Every C/C++ compile through the SDK loads the plugin. It records per-
 * function facts about calls (CFI type ids of indirect calls, where function
 * addresses flow, function-pointer casts) into a `kandelo.calltypes` custom
 * section of each object, without changing the object's code. Fork
 * instrumentation reads them from the linked module. See docs/sdk-guide.md
 * "Compiler facts for fork instrumentation".
 *
 * The plugin is a host shared library compiled against the headers of the
 * exact LLVM/Clang that loads it. It is built on first use and cached under
 * sdk/.build/calltypes-plugin/<key>/, where the key covers its sources, its
 * build script, the LLVM inputs the dev shell exports and the compiler that
 * will load it, so a source or toolchain change can never reuse a stale one.
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { run } from './exec.ts';
import { isMain } from './is-main.ts';

export const CALLTYPES_SECTION = 'kandelo.calltypes';

/** Use this prebuilt plugin instead of building one (must match the compiler). */
export const CALLTYPES_PLUGIN_ENV = 'WASM_POSIX_CALLTYPES_PLUGIN';

const SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_SOURCE_DIR = join(SDK_ROOT, 'src', 'plugin');
const PLUGIN_SOURCES = ['KandeloCallTypes.cpp', 'KandeloFnCasts.cpp', 'build.sh'];
const LLVM_INPUT_ENV = ['KANDELO_LLVM_DEV', 'KANDELO_LLVM_LIB', 'KANDELO_CLANG_DEV', 'KANDELO_CLANG_LIB'];
const BUILD_LOCK_STALE_MS = 10 * 60 * 1000;

function pluginFileName(): string {
  return process.platform === 'darwin' ? 'KandeloCallTypes.dylib' : 'KandeloCallTypes.so';
}

/** The cache key: everything the plugin's bytes and loadability depend on. */
export function calltypesPluginKey(compiler: string, env: NodeJS.ProcessEnv = process.env): string {
  const h = createHash('sha256');
  h.update('kandelo-calltypes-plugin-v1\0');
  h.update(`${process.platform}-${process.arch}\0`);
  for (const name of PLUGIN_SOURCES) {
    h.update(`${name}\0`);
    h.update(readFileSync(join(PLUGIN_SOURCE_DIR, name)));
    h.update('\0');
  }
  for (const name of LLVM_INPUT_ENV) h.update(`${name}=${env[name] ?? ''}\0`);
  let compilerIdentity = compiler;
  try {
    compilerIdentity = realpathSync(compiler);
  } catch {
    // Missing compiler: the compile itself reports it.
  }
  h.update(`compiler=${compilerIdentity}\0`);
  return h.digest('hex').slice(0, 24);
}

/**
 * The plugin path for this toolchain, building it first if needed.
 * Concurrent first compiles (make -j) build it once: one holds a lock file,
 * the rest wait for the published directory.
 */
export async function ensureCalltypesPlugin(compiler: string): Promise<string> {
  const override = process.env[CALLTYPES_PLUGIN_ENV];
  if (override) {
    if (!existsSync(override)) throw new Error(`${CALLTYPES_PLUGIN_ENV}=${override} does not exist`);
    return override;
  }
  const cacheRoot = join(SDK_ROOT, '.build', 'calltypes-plugin');
  const dir = join(cacheRoot, calltypesPluginKey(compiler));
  const plugin = join(dir, pluginFileName());
  if (existsSync(plugin)) return plugin;

  const missing = LLVM_INPUT_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `the KandeloCallTypes compiler plugin is not built for this toolchain, and ${missing.join(', ')} ` +
      'are unset, so it cannot be built here. Run the build inside scripts/dev-shell.sh ' +
      `(which exports them), or set ${CALLTYPES_PLUGIN_ENV} to a plugin built for this compiler.`,
    );
  }

  mkdirSync(cacheRoot, { recursive: true });
  const lock = `${dir}.lock`;
  for (;;) {
    if (existsSync(plugin)) return plugin;
    let fd: number;
    try {
      fd = openSync(lock, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another compile is building it. A lock older than any real build
      // belongs to a builder that died: take it over.
      try {
        if (Date.now() - statSync(lock).mtimeMs > BUILD_LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {
        // The holder just finished and removed it.
      }
      await sleep(250);
      continue;
    }
    closeSync(fd);
    try {
      if (existsSync(plugin)) return plugin;
      const staging = `${dir}.tmp-${process.pid}`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      const result = await run('bash', [join(PLUGIN_SOURCE_DIR, 'build.sh'), join(staging, pluginFileName())]);
      if (result.exitCode !== 0) {
        rmSync(staging, { recursive: true, force: true });
        throw new Error(`building the KandeloCallTypes compiler plugin failed:\n${result.stderr.trim()}`);
      }
      rmSync(dir, { recursive: true, force: true });
      renameSync(staging, dir);
      return plugin;
    } finally {
      rmSync(lock, { force: true });
    }
  }
}

// --- Wasm module inspection ------------------------------------------------

function readLeb(bytes: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (offset >= bytes.length) throw new Error('truncated LEB128 in Wasm module');
    const byte = bytes[offset++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return [result, offset];
  }
}

interface Section {
  id: number;
  start: number; // first byte of the section header
  bodyStart: number;
  end: number;
  name?: string;
}

function sections(bytes: Uint8Array): Section[] {
  if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error('not a Wasm module');
  }
  const out: Section[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const start = offset;
    const id = bytes[offset++];
    const [size, bodyStart] = readLeb(bytes, offset);
    const end = bodyStart + size;
    if (end > bytes.length) throw new Error('truncated Wasm section');
    const section: Section = { id, start, bodyStart, end };
    if (id === 0) {
      const [nameLength, nameStart] = readLeb(bytes, bodyStart);
      section.name = Buffer.from(bytes.subarray(nameStart, nameStart + nameLength)).toString('utf8');
    }
    out.push(section);
    offset = end;
  }
  return out;
}

function readName(bytes: Uint8Array, offset: number): [string, number] {
  const [length, start] = readLeb(bytes, offset);
  return [Buffer.from(bytes.subarray(start, start + length)).toString('utf8'), start + length];
}

function skipLimits(bytes: Uint8Array, offset: number): number {
  const flags = bytes[offset++];
  [, offset] = readLeb(bytes, offset);
  if (flags & 1) [, offset] = readLeb(bytes, offset);
  return offset;
}

/** Does the module import function `module.field`? */
export function importsFunction(bytes: Uint8Array, module: string, field: string): boolean {
  const imports = sections(bytes).find((s) => s.id === 2);
  if (!imports) return false;
  let [count, offset] = readLeb(bytes, imports.bodyStart);
  for (; count > 0; count--) {
    let mod: string;
    let name: string;
    [mod, offset] = readName(bytes, offset);
    [name, offset] = readName(bytes, offset);
    const kind = bytes[offset++];
    if (kind === 0x00 && mod === module && name === field) return true;
    switch (kind) {
      case 0x00: // function: type index
        [, offset] = readLeb(bytes, offset);
        break;
      case 0x01: { // table: reference type, limits
        const refType = bytes[offset++];
        if (refType === 0x63 || refType === 0x64) [, offset] = readLeb(bytes, offset);
        offset = skipLimits(bytes, offset);
        break;
      }
      case 0x02: // memory: limits
        offset = skipLimits(bytes, offset);
        break;
      case 0x03: // global: value type, mutability
        offset += 2;
        break;
      case 0x04: // tag: attribute, type index
        [, offset] = readLeb(bytes, offset + 1);
        break;
      default:
        throw new Error(`unknown import kind 0x${kind.toString(16)} in Wasm module`);
    }
  }
  return false;
}

/** The module without its custom sections named `name`. */
export function withoutCustomSection(bytes: Uint8Array, name: string): Uint8Array {
  const drop = sections(bytes).filter((s) => s.id === 0 && s.name === name);
  if (drop.length === 0) return bytes;
  const parts: Uint8Array[] = [];
  let offset = 0;
  for (const s of drop) {
    parts.push(bytes.subarray(offset, s.start));
    offset = s.end;
  }
  parts.push(bytes.subarray(offset));
  return Buffer.concat(parts);
}

/** Name of the section binding a module's facts to its linked code. */
export const CALLTYPES_CODE_HASH_SECTION = 'kandelo.calltypes.code-sha256';

function leb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

/**
 * The module with a `kandelo.calltypes.code-sha256` section: the SHA-256 of
 * its code-section payload as wasm-ld wrote it.
 *
 * WHY: some package scripts run wasm-opt themselves before instrumenting.
 * wasm-opt keeps unknown custom sections, so the facts would survive while
 * inlining moved call sites between functions, and the instrumenter would
 * analyze code the facts no longer describe. The instrumenter uses the facts
 * only when this hash still matches the code it is given.
 */
export function withCodeHashSection(bytes: Uint8Array): Uint8Array {
  const all = sections(bytes);
  const code = all.find((s) => s.id === 10);
  if (!code) return bytes;
  const digest = createHash('sha256').update(bytes.subarray(code.bodyStart, code.end)).digest();
  const name = Buffer.from(CALLTYPES_CODE_HASH_SECTION, 'utf8');
  const body = Buffer.concat([Buffer.from(leb(name.length)), name, digest]);
  const kept = withoutCustomSection(bytes, CALLTYPES_CODE_HASH_SECTION);
  return Buffer.concat([kept, Buffer.from([0, ...leb(body.length)]), body]);
}

if (isMain(import.meta.url)) {
  // `calltypes-plugin.ts <compiler>`: build if needed, print the path (used
  // by scripts/build-musl.sh, which compiles musl without the SDK driver).
  const compiler = process.argv[2];
  if (!compiler) {
    console.error('usage: calltypes-plugin.ts <clang>');
    process.exit(2);
  }
  ensureCalltypesPlugin(compiler).then(
    (path) => console.log(path),
    (error: Error) => {
      console.error(error.message);
      process.exit(1);
    },
  );
}
