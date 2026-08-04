export interface ExecutableModuleCacheOptions {
  maxEntries: number;
  maxAliases: number;
  maxRetainedBytes: number;
}

// WHY: input bytes are retained to prove exact VFS identity on every hit, and
// V8's compiled-code size is not observable here. Bound every retained index:
// 16 entries cover a small interpreter/tool working set, 256 aliases cover a
// normal Unix multicall layout, and 64 MiB admits large executables without
// turning the cache into an unbounded image mirror.
export const DEFAULT_EXECUTABLE_MODULE_CACHE_MAX_ENTRIES = 16;
export const DEFAULT_EXECUTABLE_MODULE_CACHE_MAX_ALIASES = 256;
export const DEFAULT_EXECUTABLE_MODULE_CACHE_MAX_RETAINED_BYTES =
  64 * 1024 * 1024;

export interface ExecutableModuleCacheEntry<Metadata> {
  module: WebAssembly.Module;
  metadata: Metadata;
}

export interface ExecutableModuleCacheStats {
  hits: number;
  contentAliasHits: number;
  misses: number;
  contentMismatches: number;
  evictions: number;
  aliasEvictions: number;
  retainedEntries: number;
  retainedAliases: number;
  retainedBytes: number;
}

interface RetainedExecutableModule<Metadata>
  extends ExecutableModuleCacheEntry<Metadata> {
  bytes: ArrayBuffer;
  keys: Set<string>;
}

function requireNonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/** Exact comparison keeps cache validity tied to authoritative file bytes. */
function equalBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
  if (left.byteLength !== right.byteLength) return false;

  const wordCount = Math.floor(left.byteLength / Uint32Array.BYTES_PER_ELEMENT);
  const leftWords = new Uint32Array(left, 0, wordCount);
  const rightWords = new Uint32Array(right, 0, wordCount);
  for (let index = 0; index < wordCount; index++) {
    if (leftWords[index] !== rightWords[index]) return false;
  }

  const byteOffset = wordCount * Uint32Array.BYTES_PER_ELEMENT;
  const leftTail = new Uint8Array(left, byteOffset);
  const rightTail = new Uint8Array(right, byteOffset);
  for (let index = 0; index < leftTail.byteLength; index++) {
    if (leftTail[index] !== rightTail[index]) return false;
  }
  return true;
}

/**
 * Bounded cache for immutable compiled WebAssembly executables.
 *
 * A hit reuses only a `WebAssembly.Module`; process workers, Realms, linear
 * memory, channels, and guest state remain one-shot. The cache owns an exact
 * byte copy so a path is never allowed to return code compiled from stale VFS
 * contents, even when an executable is replaced without changing its size or
 * timestamps. Identical bytes reached through different paths share one entry;
 * metadata stored here must therefore be derived only from executable content.
 */
export class ExecutableModuleCache<Metadata> {
  private readonly maxEntries: number;
  private readonly maxAliases: number;
  private readonly maxRetainedBytes: number;
  private readonly entriesByKey = new Map<
    string,
    RetainedExecutableModule<Metadata>
  >();
  private readonly entriesBySize = new Map<
    number,
    Set<RetainedExecutableModule<Metadata>>
  >();
  /** Set insertion order is the least-recently-used eviction order. */
  private readonly lru = new Set<RetainedExecutableModule<Metadata>>();
  private retainedBytes = 0;
  private hits = 0;
  private contentAliasHits = 0;
  private misses = 0;
  private contentMismatches = 0;
  private evictions = 0;
  private aliasEvictions = 0;

  constructor(options: ExecutableModuleCacheOptions) {
    this.maxEntries = requireNonNegativeSafeInteger(
      options.maxEntries,
      "Executable module cache maxEntries",
    );
    this.maxAliases = requireNonNegativeSafeInteger(
      options.maxAliases,
      "Executable module cache maxAliases",
    );
    this.maxRetainedBytes = requireNonNegativeSafeInteger(
      options.maxRetainedBytes,
      "Executable module cache maxRetainedBytes",
    );
  }

  get(key: string, bytes: ArrayBuffer): ExecutableModuleCacheEntry<Metadata> | undefined {
    const keyed = this.entriesByKey.get(key);
    if (keyed && equalBytes(keyed.bytes, bytes)) {
      this.refreshKey(key, keyed);
      this.refresh(keyed);
      this.hits++;
      return { module: keyed.module, metadata: keyed.metadata };
    }

    if (keyed) {
      this.detachKey(key, keyed);
      this.contentMismatches++;
    }

    // WHY: Homebrew and ordinary Unix images expose multicall executables and
    // hardlinks through many pathnames. Size narrows the candidates cheaply;
    // the exact comparison prevents an alias or hash collision from selecting
    // code compiled from different authoritative VFS bytes.
    const shared = this.findExactContent(bytes);
    if (shared) {
      this.attachKey(key, shared);
      this.refresh(shared);
      this.hits++;
      this.contentAliasHits++;
      return { module: shared.module, metadata: shared.metadata };
    }

    this.misses++;
    return undefined;
  }

  set(
    key: string,
    bytes: ArrayBuffer,
    module: WebAssembly.Module,
    metadata: Metadata,
  ): void {
    const prior = this.entriesByKey.get(key);
    if (prior) {
      this.detachKey(key, prior);
    }

    const shared = this.findExactContent(bytes);
    if (shared) {
      this.attachKey(key, shared);
      this.refresh(shared);
      return;
    }

    if (
      this.maxEntries === 0 ||
      bytes.byteLength > this.maxRetainedBytes
    ) {
      return;
    }

    // WHY: callers retain and sometimes transfer executable buffers. The
    // cache needs immutable comparison bytes whose ownership never leaves it.
    const ownedBytes = bytes.slice(0);
    while (
      this.lru.size >= this.maxEntries ||
      this.retainedBytes + ownedBytes.byteLength > this.maxRetainedBytes
    ) {
      const oldest = this.lru.values().next().value as
        | RetainedExecutableModule<Metadata>
        | undefined;
      if (!oldest) break;
      this.removeEntry(oldest, true);
    }

    const retained = {
      bytes: ownedBytes,
      keys: new Set<string>(),
      module,
      metadata,
    };
    let sameSize = this.entriesBySize.get(ownedBytes.byteLength);
    if (!sameSize) {
      sameSize = new Set();
      this.entriesBySize.set(ownedBytes.byteLength, sameSize);
    }
    sameSize.add(retained);
    this.lru.add(retained);
    this.retainedBytes += ownedBytes.byteLength;
    this.attachKey(key, retained);
  }

  clear(): void {
    this.entriesByKey.clear();
    this.entriesBySize.clear();
    this.lru.clear();
    this.retainedBytes = 0;
  }

  stats(): ExecutableModuleCacheStats {
    return {
      hits: this.hits,
      contentAliasHits: this.contentAliasHits,
      misses: this.misses,
      contentMismatches: this.contentMismatches,
      evictions: this.evictions,
      aliasEvictions: this.aliasEvictions,
      retainedEntries: this.lru.size,
      retainedAliases: this.entriesByKey.size,
      retainedBytes: this.retainedBytes,
    };
  }

  private findExactContent(
    bytes: ArrayBuffer,
  ): RetainedExecutableModule<Metadata> | undefined {
    for (const retained of this.entriesBySize.get(bytes.byteLength) ?? []) {
      if (equalBytes(retained.bytes, bytes)) return retained;
    }
    return undefined;
  }

  private refresh(retained: RetainedExecutableModule<Metadata>): void {
    this.lru.delete(retained);
    this.lru.add(retained);
  }

  private refreshKey(
    key: string,
    retained: RetainedExecutableModule<Metadata>,
  ): void {
    this.entriesByKey.delete(key);
    this.entriesByKey.set(key, retained);
  }

  private attachKey(
    key: string,
    retained: RetainedExecutableModule<Metadata>,
  ): void {
    retained.keys.add(key);
    this.entriesByKey.set(key, retained);
    while (this.entriesByKey.size > this.maxAliases) {
      const oldestKey = this.entriesByKey.keys().next().value as
        | string
        | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.entriesByKey.get(oldestKey)!;
      this.detachKey(oldestKey, oldest);
      this.aliasEvictions++;
    }
  }

  private detachKey(
    key: string,
    retained: RetainedExecutableModule<Metadata>,
  ): void {
    this.entriesByKey.delete(key);
    retained.keys.delete(key);
    if (retained.keys.size === 0) this.removeEntry(retained, false);
  }

  private removeEntry(
    retained: RetainedExecutableModule<Metadata>,
    eviction: boolean,
  ): void {
    for (const key of retained.keys) this.entriesByKey.delete(key);
    retained.keys.clear();
    const sameSize = this.entriesBySize.get(retained.bytes.byteLength);
    sameSize?.delete(retained);
    if (sameSize?.size === 0) {
      this.entriesBySize.delete(retained.bytes.byteLength);
    }
    this.lru.delete(retained);
    this.retainedBytes -= retained.bytes.byteLength;
    if (eviction) this.evictions++;
  }
}
