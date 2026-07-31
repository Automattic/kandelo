export const DEFAULT_EXECUTABLE_MODULE_CACHE_ENTRIES = 8;
export const DEFAULT_EXECUTABLE_MODULE_CACHE_SOURCE_BYTES = 64 * 1024 * 1024;

type CompileModule<T> = (bytes: ArrayBuffer) => Promise<T>;
type DigestBytes = (bytes: ArrayBuffer) => Promise<string>;

export interface ExecutableModuleCacheOptions<T> {
  maxEntries?: number;
  maxSourceBytes?: number;
  compile?: CompileModule<T>;
  digest?: DigestBytes;
}

interface CacheEntry<T> {
  module: Promise<T>;
  sourceBytes: number;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "Executable module caching requires Web Crypto SHA-256 support",
    );
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function requireCacheLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Bounded cache for executable WebAssembly modules shared by Node and browser
 * kernel workers.
 *
 * Callers still own and pass the exact current executable bytes to each
 * process Worker. This cache retains only the compiled module and uses the
 * complete byte snapshot's SHA-256 plus length as its identity.
 */
export class ExecutableModuleCache<T = WebAssembly.Module> {
  readonly maxEntries: number;
  readonly maxSourceBytes: number;

  private readonly compile: CompileModule<T>;
  private readonly digest: DigestBytes;
  private readonly entries = new Map<string, CacheEntry<T>>();
  private cachedSourceBytes = 0;

  constructor(options: ExecutableModuleCacheOptions<T> = {}) {
    this.maxEntries = requireCacheLimit(
      options.maxEntries ?? DEFAULT_EXECUTABLE_MODULE_CACHE_ENTRIES,
      "Executable module cache entry limit",
    );
    this.maxSourceBytes = requireCacheLimit(
      options.maxSourceBytes ?? DEFAULT_EXECUTABLE_MODULE_CACHE_SOURCE_BYTES,
      "Executable module cache source-byte limit",
    );
    this.compile =
      options.compile ??
      (async (bytes) => (await WebAssembly.compile(bytes)) as T);
    this.digest = options.digest ?? sha256Hex;
  }

  get size(): number {
    return this.entries.size;
  }

  get sourceBytes(): number {
    return this.cachedSourceBytes;
  }

  clear(): void {
    this.entries.clear();
    this.cachedSourceBytes = 0;
  }

  async getOrCompile(bytes: ArrayBuffer): Promise<T> {
    // Skip both hashing and retention when caching is disabled or when one
    // large executable would exceed the cache's declared weight by itself.
    if (this.maxEntries === 0 || bytes.byteLength > this.maxSourceBytes) {
      return await this.compile(bytes);
    }

    // WHY: pathname, inode timestamps, and file size cannot prove immutable
    // executable content. Aliases have different names, and a same-tick write
    // can replace bytes without changing coarse metadata. Hash the prepared
    // read snapshot so a hit always names the bytes being launched.
    const digest = await this.digest(bytes);
    const key = `${bytes.byteLength}:${digest}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.touch(key, cached);
      return await cached.module;
    }

    // Install the promise before compilation starts. Two spawn/exec requests
    // that resolve the same bytes concurrently then await one compiler job.
    const entry: CacheEntry<T> = {
      module: Promise.resolve().then(() => this.compile(bytes)),
      sourceBytes: bytes.byteLength,
    };
    this.entries.set(key, entry);
    this.cachedSourceBytes += entry.sourceBytes;
    this.evictToBounds();

    try {
      return await entry.module;
    } catch (error) {
      // A failed compiler promise must not poison later retries. Check object
      // identity because this entry may have been evicted and replaced while
      // its asynchronous compilation was still settling.
      if (this.entries.get(key) === entry) this.remove(key, entry);
      throw error;
    }
  }

  private touch(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private remove(key: string, entry: CacheEntry<T>): void {
    if (!this.entries.delete(key)) return;
    this.cachedSourceBytes -= entry.sourceBytes;
  }

  private evictToBounds(): void {
    // WebAssembly exposes no portable compiled-code byte count. Bound both the
    // number of retained modules and the sum of their source byte sizes; the
    // latter is the closest cross-engine weight available without retaining
    // the source ArrayBuffers themselves.
    while (
      this.entries.size > this.maxEntries ||
      this.cachedSourceBytes > this.maxSourceBytes
    ) {
      const oldest = this.entries.entries().next().value as
        [string, CacheEntry<T>] | undefined;
      if (!oldest) break;
      this.remove(oldest[0], oldest[1]);
    }
  }
}
