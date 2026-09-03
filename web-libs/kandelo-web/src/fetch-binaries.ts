/**
 * Release-fetch loader for `@kandelo/web`.
 *
 * The npm package ships **code only** — no kernel wasm, no rootfs image, no
 * program binaries. The Wasm artifacts live in a Kandelo *binaries release*
 * (a GitHub release, a fork's release, or any URL serving the same layout) and
 * are fetched at runtime by the functions here.
 *
 * A binaries release is an `index.toml` plus content-addressed `.tar.zst`
 * archives, one per package:
 *
 *   index.toml                                  (abi_version + per-package entries)
 *   kernel-0.1.0-rev1-abi15-wasm32-<sha>.tar.zst   -> artifacts/kandelo-kernel.wasm
 *   rootfs-0.1.0-rev4-abi15-wasm32-<sha>.tar.zst   -> artifacts/rootfs.vfs
 *   php-8.3.2-rev3-abi15-wasm32-<sha>.tar.zst      -> artifacts/php.wasm, ...
 *
 * `index.toml` records `archive_url` (relative to the release base) and
 * `archive_sha256` for each package/arch. The loader fetches the archive,
 * verifies its sha256, `fzstd`-decompresses it, untars it (ustar), and returns
 * the `artifacts/*` payloads.
 *
 * ## Binary source is a first-class parameter
 *
 * Nothing here hardcodes the canonical repo. Point the loader at:
 *   - `{ repo: "myorg/my-fork", tag: "binaries-abi-v42" }` — a fork's release,
 *   - `{ baseUrl: "https://cdn.example/bins/" }` — self-built binaries hosted
 *     anywhere (static server, local dev server, S3, ...),
 *   - nothing — defaults to `Automattic/kandelo` + the tag matching the ABI
 *     this build of `@kandelo/web` speaks.
 *
 * ## Caching is the consumer's choice
 *
 * The loader performs plain `fetch()` and stays cache-agnostic. Inject a custom
 * `fetch` (the `fetch` option) to layer CacheStorage / IndexedDB / auth / a
 * proxy however you like — it receives the same `(url, init)` signature.
 *
 * ## ABI safety
 *
 * Because an external source can hold a different ABI, the loader compares the
 * release's `abi_version` against this package's {@link ABI_VERSION} and throws
 * on mismatch unless `allowAbiMismatch` is set. A kernel/program built for a
 * different ABI cannot run; surfacing that as a loud failure is the ABI
 * contract, not a convenience.
 */
import { decompress as zstdDecompress } from "fzstd";

import { ABI_VERSION } from "../../../host/src/generated/abi";

/** The release tag holding ABI-matched binaries for this build: `binaries-abi-v<N>`. */
const BINARIES_RELEASE_TAG = `binaries-abi-v${ABI_VERSION}`;

/** Where a binaries release lives. Resolution precedence: `baseUrl` > `repo`+`tag`. */
export interface KandeloBinarySource {
  /**
   * Full base URL that hosts `index.toml` and the archives, e.g.
   * `"https://cdn.example/kandelo/abi15/"`. Takes precedence over `repo`/`tag`.
   * A trailing slash is added if missing.
   */
  baseUrl?: string;
  /** GitHub `owner/repo` whose release holds the binaries. Default `"Automattic/kandelo"`. */
  repo?: string;
  /** Release tag. Default {@link BINARIES_RELEASE_TAG} (matches this package's ABI). */
  tag?: string;
}

/** Target architecture for the fetched artifacts. */
export type KandeloArch = "wasm32" | "wasm64";

export interface KandeloFetchOptions extends KandeloBinarySource {
  /** Target arch. Default `"wasm32"`. */
  arch?: KandeloArch;
  /**
   * Custom fetch — the injection point for caching, auth, or proxying. Receives
   * the standard `(input, init)` signature. Default `globalThis.fetch`.
   */
  fetch?: typeof fetch;
  /** Skip `archive_sha256` verification. Default `false` (verification on). */
  skipIntegrityCheck?: boolean;
  /**
   * Load binaries whose release `abi_version` differs from this package's
   * {@link ABI_VERSION}. Default `false` — a mismatch throws.
   */
  allowAbiMismatch?: boolean;
  /** A pre-fetched index to reuse (avoids re-downloading `index.toml`). */
  index?: KandeloReleaseIndex;
}

/** One package's binary entry for a single arch, parsed from `index.toml`. */
export interface KandeloIndexEntry {
  name: string;
  version: string;
  revision: number;
  status: string;
  /** Archive URL as written in the index (may be relative to the release base). */
  archiveUrl: string;
  archiveSha256: string;
}

/** Parsed `index.toml` for one release. */
export interface KandeloReleaseIndex {
  /** ABI version the release was built for. */
  abiVersion: number;
  /** Absolute base URL the archive URLs resolve against. */
  baseUrl: string;
  /** Arch these entries were filtered to. */
  arch: KandeloArch;
  /** Package name -> binary entry (for {@link arch}). */
  packages: Map<string, KandeloIndexEntry>;
}

/** The contents of one fetched package archive. */
export interface KandeloPackageArtifacts {
  name: string;
  version: string;
  revision: number;
  /** Artifact basename (e.g. `"php.wasm"`) -> bytes, from the archive's `artifacts/`. */
  artifacts: Record<string, Uint8Array>;
}

/** The kernel and rootfs bytes, shaped for `BrowserKernel.boot()`. */
export interface KandeloBinaries {
  /** Kernel module bytes, for `boot({ kernelWasm })`. */
  kernelWasm: ArrayBuffer;
  /** Root filesystem image, for `boot({ vfsImage })`. */
  rootfsVfs: Uint8Array;
}

const DEFAULT_REPO = "Automattic/kandelo";

/** Normalize the `string | options` argument the public functions accept. */
function normalizeOptions(arg?: string | KandeloFetchOptions): KandeloFetchOptions {
  return typeof arg === "string" ? { tag: arg } : { ...(arg ?? {}) };
}

/**
 * Resolve the release base URL (always trailing-slashed) from a source. A
 * relative `baseUrl` — the same-origin proxy pattern — resolves against the
 * page URL, so that archive URLs derived from it later (`new URL(archive,
 * base)`) have the absolute base the URL constructor requires.
 */
function resolveBaseUrl(src: KandeloBinarySource): string {
  if (src.baseUrl) {
    const base = src.baseUrl.endsWith("/") ? src.baseUrl : `${src.baseUrl}/`;
    const pageHref = (globalThis as { location?: { href: string } }).location?.href;
    return pageHref ? new URL(base, pageHref).href : base;
  }
  const repo = src.repo ?? DEFAULT_REPO;
  const tag = src.tag ?? BINARIES_RELEASE_TAG;
  return `https://github.com/${repo}/releases/download/${tag}/`;
}

function getFetch(opts: KandeloFetchOptions): typeof fetch {
  const f = opts.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
  if (!f) {
    throw new Error(
      "@kandelo/web: no fetch available. Pass a `fetch` implementation in options " +
        "(the injection point for caching/auth/proxying).",
    );
  }
  return f;
}

async function fetchBytes(f: typeof fetch, url: string, what: string): Promise<Uint8Array> {
  const res = await f(url);
  if (!res.ok) {
    throw new Error(`@kandelo/web: failed to fetch ${what} from ${url}: ${res.status} ${res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "@kandelo/web: SubtleCrypto unavailable for archive_sha256 verification. " +
        "Run in a secure context, or pass `skipIntegrityCheck: true` to opt out.",
    );
  }
  const digest = await subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Minimal TOML reader for the index ────────────────────────────────────────
//
// The index is machine-generated and regular; a purpose-built reader avoids a
// TOML dependency. We only need: a top-level `abi_version`, repeated
// `[[packages]]` tables (name/version/revision), and their
// `[packages.binary.<arch>]` subtables (status/archive_url/archive_sha256).

function parseScalar(raw: string): string | number {
  const v = raw.trim();
  if (v.startsWith('"')) {
    const end = v.lastIndexOf('"');
    return end > 0 ? v.slice(1, end) : v.slice(1);
  }
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

interface ParsedIndex {
  abiVersion: number;
  packages: Map<string, { version: string; revision: number; binary: Map<string, KandeloIndexEntry> }>;
}

function parseIndexToml(text: string): ParsedIndex {
  let abiVersion = NaN;
  const packages = new Map<string, { version: string; revision: number; binary: Map<string, KandeloIndexEntry> }>();

  type Section = "root" | "package" | "binary";
  let section: Section = "root";
  let pkg: { name: string; version: string; revision: number; binary: Map<string, KandeloIndexEntry> } | undefined;
  let arch: string | undefined;
  // Staging for the current binary subtable before we know its name (name comes
  // from the enclosing package, already known).
  let bin: Partial<KandeloIndexEntry> | undefined;

  const flushPkg = () => {
    if (pkg) packages.set(pkg.name, { version: pkg.version, revision: pkg.revision, binary: pkg.binary });
  };
  const flushBin = () => {
    if (pkg && arch && bin) {
      pkg.binary.set(arch, {
        name: pkg.name,
        version: pkg.version,
        revision: pkg.revision,
        status: String(bin.status ?? ""),
        archiveUrl: String(bin.archiveUrl ?? ""),
        archiveSha256: String(bin.archiveSha256 ?? ""),
      });
    }
    bin = undefined;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line === "[[packages]]") {
      flushBin();
      flushPkg();
      pkg = { name: "", version: "", revision: 0, binary: new Map() };
      arch = undefined;
      section = "package";
      continue;
    }

    const binMatch = /^\[packages\.binary\.([A-Za-z0-9_]+)\]$/.exec(line);
    if (binMatch) {
      flushBin();
      arch = binMatch[1];
      bin = {};
      section = "binary";
      continue;
    }

    if (line.startsWith("[")) {
      // Some other table; ignore until the next [[packages]] / binary subtable.
      flushBin();
      section = "root";
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = parseScalar(line.slice(eq + 1));

    if (section === "root") {
      if (key === "abi_version") abiVersion = Number(value);
    } else if (section === "package" && pkg) {
      if (key === "name") pkg.name = String(value);
      else if (key === "version") pkg.version = String(value);
      else if (key === "revision") pkg.revision = Number(value);
    } else if (section === "binary" && bin) {
      if (key === "status") bin.status = String(value);
      else if (key === "archive_url") bin.archiveUrl = String(value);
      else if (key === "archive_sha256") bin.archiveSha256 = String(value);
    }
  }
  flushBin();
  flushPkg();

  return { abiVersion, packages };
}

// ── Minimal ustar reader ─────────────────────────────────────────────────────
//
// The archives are plain (ustar/GNU) tar inside zstd. Headers are 512 bytes;
// data is padded to 512. Two consecutive zero blocks end the stream. We keep
// only regular files and honor the ustar `prefix` field for long paths.

function readTarString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(offset, end));
}

function untar(buf: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const out: Array<{ name: string; data: Uint8Array }> = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    // All-zero block marks end of archive.
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const name = readTarString(header, 0, 100);
    const sizeStr = readTarString(header, 124, 12).trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const typeflag = header[156];
    const prefix = readTarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;

    const dataStart = off + 512;
    // typeflag '0' or NUL => regular file.
    if ((typeflag === 0x30 || typeflag === 0) && name) {
      out.push({ name: fullName, data: buf.subarray(dataStart, dataStart + size) });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch and parse a release's `index.toml`. Verifies the release's
 * `abi_version` against this package's {@link ABI_VERSION} (unless
 * `allowAbiMismatch`).
 */
export async function fetchKandeloIndex(
  source?: string | KandeloFetchOptions,
): Promise<KandeloReleaseIndex> {
  const opts = normalizeOptions(source);
  const f = getFetch(opts);
  const arch: KandeloArch = opts.arch ?? "wasm32";
  const baseUrl = resolveBaseUrl(opts);

  const text = new TextDecoder().decode(await fetchBytes(f, `${baseUrl}index.toml`, "index.toml"));
  const parsed = parseIndexToml(text);

  if (!Number.isFinite(parsed.abiVersion)) {
    throw new Error(`@kandelo/web: ${baseUrl}index.toml has no abi_version`);
  }
  if (!opts.allowAbiMismatch && parsed.abiVersion !== ABI_VERSION) {
    throw new Error(
      `@kandelo/web: ABI mismatch — this build speaks ABI ${ABI_VERSION} but the ` +
        `release at ${baseUrl} is ABI ${parsed.abiVersion}. Binaries built for a ` +
        `different ABI cannot run. Point at an ABI-${ABI_VERSION} release, or pass ` +
        `allowAbiMismatch: true if you know what you are doing.`,
    );
  }

  const packages = new Map<string, KandeloIndexEntry>();
  for (const [name, pkg] of parsed.packages) {
    const entry = pkg.binary.get(arch);
    if (entry) packages.set(name, entry);
  }

  return { abiVersion: parsed.abiVersion, baseUrl, arch, packages };
}

/**
 * Fetch one package's archive from a release, verify its `archive_sha256`,
 * decompress + untar it, and return the `artifacts/*` payloads keyed by
 * basename (e.g. `"php.wasm"`, `"php-fpm.wasm"`, `"opcache.so"`).
 */
export async function fetchKandeloPackage(
  name: string,
  source?: string | KandeloFetchOptions,
): Promise<KandeloPackageArtifacts> {
  const opts = normalizeOptions(source);
  const f = getFetch(opts);
  const index = opts.index ?? (await fetchKandeloIndex(opts));

  const entry = index.packages.get(name);
  if (!entry) {
    throw new Error(
      `@kandelo/web: package "${name}" (${index.arch}) not found in ${index.baseUrl}index.toml`,
    );
  }
  if (entry.status !== "success") {
    throw new Error(
      `@kandelo/web: package "${name}" (${index.arch}) has status "${entry.status}" in the index`,
    );
  }

  const archiveUrl = new URL(entry.archiveUrl, index.baseUrl).href;
  const archive = await fetchBytes(f, archiveUrl, `archive for "${name}"`);

  if (!opts.skipIntegrityCheck) {
    const actual = await sha256Hex(archive);
    if (actual !== entry.archiveSha256) {
      throw new Error(
        `@kandelo/web: archive_sha256 mismatch for "${name}" (${archiveUrl})\n` +
          `  expected ${entry.archiveSha256}\n  actual   ${actual}`,
      );
    }
  }

  const tar = zstdDecompress(archive);
  const artifacts: Record<string, Uint8Array> = {};
  for (const f2 of untar(tar)) {
    const m = /^artifacts\/(.+)$/.exec(f2.name);
    if (m) artifacts[m[1]] = f2.data;
  }

  return { name: entry.name, version: entry.version, revision: entry.revision, artifacts };
}

/**
 * Fetch the kernel and rootfs from a binaries release and return their bytes,
 * shaped for `BrowserKernel.boot()`.
 *
 * ```ts
 * const { kernelWasm, rootfsVfs } = await fetchKandeloBinaries();
 * const kernel = new BrowserKernel({ onStdout });
 * await kernel.boot({ kernelWasm, vfsImage: rootfsVfs });
 * ```
 *
 * Point at a fork or self-hosted binaries with the source options:
 * `fetchKandeloBinaries({ repo: "myorg/fork" })` or
 * `fetchKandeloBinaries({ baseUrl: "https://cdn.example/bins/" })`.
 */
export async function fetchKandeloBinaries(
  source?: string | KandeloFetchOptions,
): Promise<KandeloBinaries> {
  const opts = normalizeOptions(source);
  const index = opts.index ?? (await fetchKandeloIndex(opts));
  const withIndex: KandeloFetchOptions = { ...opts, index };

  const [kernelPkg, rootfsPkg] = await Promise.all([
    fetchKandeloPackage("kernel", withIndex),
    fetchKandeloPackage("rootfs", withIndex),
  ]);

  const kernelWasm = kernelPkg.artifacts["kandelo-kernel.wasm"];
  const rootfsVfs = rootfsPkg.artifacts["rootfs.vfs"];
  if (!kernelWasm) {
    throw new Error(
      `@kandelo/web: kernel archive has no artifacts/kandelo-kernel.wasm (got: ${Object.keys(kernelPkg.artifacts).join(", ")})`,
    );
  }
  if (!rootfsVfs) {
    throw new Error(
      `@kandelo/web: rootfs archive has no artifacts/rootfs.vfs (got: ${Object.keys(rootfsPkg.artifacts).join(", ")})`,
    );
  }

  // `boot()` takes the kernel as an ArrayBuffer and the image as a Uint8Array.
  // Slice the kernel out of its tar-backed buffer so the caller owns one whole
  // buffer, which is also what the ownership-transferring boot path requires.
  return {
    kernelWasm: kernelWasm.buffer.slice(
      kernelWasm.byteOffset,
      kernelWasm.byteOffset + kernelWasm.byteLength,
    ) as ArrayBuffer,
    rootfsVfs,
  };
}
