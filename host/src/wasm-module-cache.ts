/**
 * Content-addressed cache of compiled WebAssembly modules, owned by the
 * kernel worker on both hosts.
 *
 * Every engine Kandelo runs on shares one `WebAssembly.Module`'s compiled
 * code with each worker the module is posted to, while each separate
 * compilation of the same bytes produces another full copy of machine code.
 * Compiled code is the dominant browser cost for large guests (SpiderMonkey
 * caps all of it at 2 GiB per content process), so the kernel worker
 * compiles a given program once and posts that one module to every process
 * and thread worker that runs the same bytes.
 *
 * Identity is the exact bytes: a SHA-256 digest plus the byte length, never a
 * path. A file rewritten in place hashes differently at its next exec, so it
 * can never run a module compiled from older contents. The cache only
 * replaces the compile step; callers keep running every admission check
 * (ABI marker, artifact policy, exec permission, fork-instrumentation
 * validation) on the bytes of each launch, hit or miss.
 *
 * Lifetime. The cache holds no module alive by itself beyond the bounded
 * retention window below. Each entry is a `WeakRef`: the strong references
 * belong to the users of a module — the kernel worker's per-process records
 * and launch continuations still in flight — so a module stays shareable
 * exactly while some live process or pending launch holds it, and becomes
 * collectable with its last user. A finalization callback then drops the
 * stale key. On top of that, a small LRU retains recently launched modules
 * strongly for {@link DEFAULT_WASM_MODULE_RETENTION}'s idle window, bounded by
 * total Wasm bytes, so a short program run repeatedly from a shell (`ls`,
 * `cat`, a build step) does not recompile on every run merely because the
 * garbage collector happened to run between two launches. Modules larger than
 * the byte bound are never retained past their last user.
 */

/** Which instantiation shape of a program's bytes a module was compiled for. */
export type WasmModuleVariant = "program" | "thread";

export interface WasmModuleRetentionPolicy {
  /**
   * Upper bound on the summed Wasm byte length of modules held strongly by
   * the retention window. Zero disables retention.
   */
  readonly maxBytes: number;
  /** How long a module stays retained after its most recent launch. */
  readonly idleMs: number;
}

/**
 * Retain recently launched modules up to 16 MiB of Wasm bytes for 30 seconds
 * after their last launch. See docs/architecture.md "Compiled module sharing"
 * for the measurements behind these values.
 */
export const DEFAULT_WASM_MODULE_RETENTION: WasmModuleRetentionPolicy =
  Object.freeze({ maxBytes: 16 * 1024 * 1024, idleMs: 30_000 });

export interface WasmModuleCacheStats {
  /** Engine compilations started by the cache. */
  readonly compiles: number;
  /** Engine compilations that rejected (each one is also in `compiles`). */
  readonly compileFailures: number;
  /** Summed wall time of those compilations. */
  readonly compileMs: number;
  /** Summed byte length of the Wasm bytes those compilations consumed. */
  readonly compiledBytes: number;
  /** Requests satisfied by a module that was already compiled. */
  readonly hits: number;
  /** Requests that joined a compilation of the same bytes already running. */
  readonly joins: number;
  /** SHA-256 digests computed. */
  readonly digests: number;
  /** Summed wall time of those digests. */
  readonly digestMs: number;
  /** Summed byte length hashed. */
  readonly digestedBytes: number;
  /** Keys whose module is still reachable. */
  readonly liveEntries: number;
  /** Modules currently held by the retention window. */
  readonly retainedEntries: number;
  /** Summed Wasm byte length of those modules. */
  readonly retainedBytes: number;
}

export interface WasmModuleCacheOptions {
  readonly compile?: (bytes: ArrayBuffer) => Promise<WebAssembly.Module>;
  readonly digest?: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  readonly retention?: WasmModuleRetentionPolicy;
  readonly now?: () => number;
}

interface ContentIdentity {
  /** `<byte length>:<sha-256 hex>` of the exact bytes. */
  readonly id: string;
  readonly byteLength: number;
}

interface WeakEntry {
  readonly ref: WeakRef<WebAssembly.Module>;
}

interface RetainedEntry {
  readonly module: WebAssembly.Module;
  readonly byteLength: number;
  expiresAt: number;
}

interface MutableStats {
  compiles: number;
  compileFailures: number;
  compileMs: number;
  compiledBytes: number;
  hits: number;
  joins: number;
  digests: number;
  digestMs: number;
  digestedBytes: number;
}

function toHex(digest: ArrayBuffer): string {
  let hex = "";
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function defaultDigest(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "SHA-256 is unavailable; the compiled-module cache requires WebCrypto",
    );
  }
  return subtle.digest("SHA-256", bytes);
}

export class WasmModuleCache {
  readonly #compile: (bytes: ArrayBuffer) => Promise<WebAssembly.Module>;
  readonly #digest: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
  readonly #retention: WasmModuleRetentionPolicy;
  readonly #now: () => number;
  readonly #entries = new Map<string, WeakEntry>();
  readonly #inflight = new Map<string, Promise<WebAssembly.Module>>();
  /**
   * Digests of byte buffers this cache already hashed, by buffer identity.
   * A process record keeps the exact `ArrayBuffer` its module was looked up
   * with, and admitted program bytes are never written afterwards, so a
   * later thread-variant lookup for that process need not hash them again.
   */
  readonly #identities = new WeakMap<ArrayBuffer, ContentIdentity>();
  readonly #retained = new Map<string, RetainedEntry>();
  #retainedBytes = 0;
  #sweepTimer: ReturnType<typeof setTimeout> | null = null;
  #sweepAt = Infinity;
  readonly #finalizer = new FinalizationRegistry<string>((key) => {
    const entry = this.#entries.get(key);
    if (entry && entry.ref.deref() === undefined) this.#entries.delete(key);
  });
  readonly #stats: MutableStats = {
    compiles: 0,
    compileFailures: 0,
    compileMs: 0,
    compiledBytes: 0,
    hits: 0,
    joins: 0,
    digests: 0,
    digestMs: 0,
    digestedBytes: 0,
  };

  constructor(options: WasmModuleCacheOptions = {}) {
    this.#compile = options.compile ?? ((bytes) => WebAssembly.compile(bytes));
    this.#digest = options.digest ?? defaultDigest;
    this.#retention = options.retention ?? DEFAULT_WASM_MODULE_RETENTION;
    this.#now = options.now ?? (() => performance.now());
  }

  /**
   * The module for exactly `bytes`, compiled at most once while a compiled
   * copy is reachable. Rejects with the engine's own error (for example
   * `WebAssembly.CompileError`) when the bytes do not compile; failures are
   * never cached.
   */
  async programModule(bytes: ArrayBuffer): Promise<WebAssembly.Module> {
    const identity = await this.#identify(bytes);
    return this.#getOrCompile(
      "program",
      identity,
      () => this.#compileBytes(bytes),
    );
  }

  /**
   * The thread-entry module for a program, keyed by the program's own bytes.
   * `patchForThread` must be a pure function of those bytes. When it leaves
   * them unchanged, the thread module is the program module itself.
   */
  async threadModule(
    programBytes: ArrayBuffer,
    patchForThread: (bytes: ArrayBuffer) => ArrayBuffer,
  ): Promise<WebAssembly.Module> {
    const identity = await this.#identify(programBytes);
    return this.#getOrCompile("thread", identity, () => {
      const patched = patchForThread(programBytes);
      if (patched !== programBytes) return this.#compileBytes(patched);
      return this.#getOrCompile(
        "program",
        identity,
        () => this.#compileBytes(programBytes),
      );
    });
  }

  stats(): WasmModuleCacheStats {
    let liveEntries = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.ref.deref() === undefined) this.#entries.delete(key);
      else liveEntries += 1;
    }
    return {
      ...this.#stats,
      liveEntries,
      retainedEntries: this.#retained.size,
      retainedBytes: this.#retainedBytes,
    };
  }

  /** Drop every entry and retained module, e.g. when the kernel is destroyed. */
  clear(): void {
    this.#entries.clear();
    this.#inflight.clear();
    this.#retained.clear();
    this.#retainedBytes = 0;
    this.#cancelSweep();
  }

  async #identify(bytes: ArrayBuffer): Promise<ContentIdentity> {
    const known = this.#identities.get(bytes);
    if (known && known.byteLength === bytes.byteLength) return known;
    const byteLength = bytes.byteLength;
    const start = this.#now();
    const digest = await this.#digest(bytes);
    this.#stats.digests += 1;
    this.#stats.digestMs += this.#now() - start;
    this.#stats.digestedBytes += byteLength;
    const identity: ContentIdentity = {
      id: `${byteLength}:${toHex(digest)}`,
      byteLength,
    };
    this.#identities.set(bytes, identity);
    return identity;
  }

  #getOrCompile(
    variant: WasmModuleVariant,
    identity: ContentIdentity,
    produce: () => Promise<WebAssembly.Module>,
  ): Promise<WebAssembly.Module> {
    const key = `${variant}:${identity.id}`;
    const cached = this.#entries.get(key)?.ref.deref();
    if (cached !== undefined) {
      this.#stats.hits += 1;
      this.#retain(key, cached, identity.byteLength);
      return Promise.resolve(cached);
    }
    const pending = this.#inflight.get(key);
    if (pending) {
      this.#stats.joins += 1;
      return pending;
    }
    const compilation = (async () => {
      const module = await produce();
      this.#entries.set(key, { ref: new WeakRef(module) });
      this.#finalizer.register(module, key);
      this.#retain(key, module, identity.byteLength);
      return module;
    })();
    this.#inflight.set(key, compilation);
    const settle = () => {
      if (this.#inflight.get(key) === compilation) this.#inflight.delete(key);
    };
    compilation.then(settle, settle);
    return compilation;
  }

  async #compileBytes(bytes: ArrayBuffer): Promise<WebAssembly.Module> {
    const start = this.#now();
    this.#stats.compiles += 1;
    this.#stats.compiledBytes += bytes.byteLength;
    try {
      return await this.#compile(bytes);
    } catch (error) {
      this.#stats.compileFailures += 1;
      throw error;
    } finally {
      this.#stats.compileMs += this.#now() - start;
    }
  }

  #retain(key: string, module: WebAssembly.Module, byteLength: number): void {
    const { maxBytes, idleMs } = this.#retention;
    const previous = this.#retained.get(key);
    if (previous) {
      this.#retained.delete(key);
      this.#retainedBytes -= previous.byteLength;
    }
    if (maxBytes <= 0 || idleMs <= 0 || byteLength > maxBytes) return;
    const expiresAt = this.#now() + idleMs;
    // Map order is launch recency: re-inserting moves the key to the end.
    this.#retained.set(key, { module, byteLength, expiresAt });
    this.#retainedBytes += byteLength;
    for (const [oldest, entry] of this.#retained) {
      if (this.#retainedBytes <= maxBytes) break;
      this.#retained.delete(oldest);
      this.#retainedBytes -= entry.byteLength;
    }
    this.#scheduleSweep(expiresAt);
  }

  #scheduleSweep(at: number): void {
    if (this.#sweepTimer !== null && this.#sweepAt <= at) return;
    this.#cancelSweep();
    this.#sweepAt = at;
    const timer = setTimeout(
      () => this.#sweep(),
      Math.max(0, at - this.#now()),
    );
    // A retained module must never keep a Node kernel worker alive.
    (timer as { unref?: () => void }).unref?.();
    this.#sweepTimer = timer;
  }

  #cancelSweep(): void {
    if (this.#sweepTimer !== null) clearTimeout(this.#sweepTimer);
    this.#sweepTimer = null;
    this.#sweepAt = Infinity;
  }

  #sweep(): void {
    this.#sweepTimer = null;
    this.#sweepAt = Infinity;
    const now = this.#now();
    let next = Infinity;
    for (const [key, entry] of this.#retained) {
      if (entry.expiresAt <= now) {
        this.#retained.delete(key);
        this.#retainedBytes -= entry.byteLength;
      } else {
        next = Math.min(next, entry.expiresAt);
      }
    }
    if (next !== Infinity) this.#scheduleSweep(next);
  }
}
