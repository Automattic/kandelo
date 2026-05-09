/**
 * Build-script helper: download + verify + extract an upstream source
 * tarball, returning the extracted directory.
 *
 * Used by VFS build scripts (build-python-vfs-image.ts,
 * build-perl-vfs-image.ts, etc.) to obtain stdlib trees / data files
 * that are not part of the binary release archives but ARE in the
 * upstream source. The URL and sha256 are read from the same
 * `examples/libs/<name>/package.toml` `[source]` block the package
 * resolver consults — single source of truth, no duplication.
 *
 * Why this exists: the package resolver caches build *outputs* (.wasm
 * binaries) but not source extracts. A fetch-only checkout has the
 * binaries but not the source trees. Calling the upstream build
 * script (e.g. build-cpython.sh) would re-extract AND recompile,
 * which is the slow part we want to skip.
 *
 * If the legacy local-build path (e.g.
 * `examples/libs/cpython/cpython-src/`) already exists, the helper
 * prefers it — that path is what `bash examples/libs/cpython/build-cpython.sh`
 * leaves on disk, so existing local-build users are unaffected.
 *
 * Cache layout: `~/.cache/wasm-posix-kernel/vfs-build-sources/<name>-<sha8>/`.
 * The 8-char sha prefix uniquely identifies the upstream tarball — bumping
 * `[source].url` or `sha256` invalidates the cache automatically.
 */
import { readFileSync, existsSync, mkdirSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

interface SourceInfo {
  url: string;
  sha256: string;
}

/** Parse the `[source]` block out of a package.toml file. */
function readSourceBlock(tomlPath: string): SourceInfo {
  const text = readFileSync(tomlPath, "utf-8");
  // Match `[source]` followed by url + sha256 lines (in either order).
  // The block ends at the next `[section]` header or EOF.
  const blockMatch = text.match(/^\[source\]\s*$([\s\S]*?)(?=^\[|\Z)/m);
  if (!blockMatch) {
    throw new Error(`${tomlPath}: no [source] block found`);
  }
  const block = blockMatch[1];
  const url = block.match(/^url\s*=\s*"([^"]+)"/m)?.[1];
  const sha256 = block.match(/^sha256\s*=\s*"([^"]+)"/m)?.[1];
  if (!url || !sha256) {
    throw new Error(`${tomlPath}: [source] missing url/sha256`);
  }
  return { url, sha256 };
}

/** Pick the right `tar` flag for a given tarball filename. */
function tarDecompressFlag(filename: string): string {
  if (filename.endsWith(".tar.xz") || filename.endsWith(".txz")) return "-J";
  if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) return "-z";
  if (filename.endsWith(".tar.bz2") || filename.endsWith(".tbz2")) return "-j";
  if (filename.endsWith(".tar.zst")) return "--zstd";
  if (filename.endsWith(".tar")) return "";
  throw new Error(`Unsupported archive extension: ${filename}`);
}

function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

export interface ExtractOptions {
  url: string;
  sha256: string;
  /**
   * Cache key segment used in the extract dir path. The full sha256 is
   * also folded in for uniqueness, but the key disambiguates two different
   * artifacts that happen to share a leading sha prefix.
   */
  cacheKey: string;
  /**
   * If set and the path exists, return it as-is instead of downloading.
   * Lets the local source-build workflow (e.g. perl-src/) keep working.
   */
  legacyPath?: string;
  /**
   * tar `--strip-components=N` value. Defaults to 1 (drops the top-level
   * `<name>-<version>/` wrapper that source tarballs typically have).
   * Set to 0 for archives whose contents should keep the top-level dir.
   */
  stripComponents?: number;
}

/**
 * Generic source-archive extractor: download from url, verify sha256,
 * extract to a content-addressed cache, return the directory.
 *
 * Supports tar (.tar, .tar.{gz,xz,bz2,zst}) and .zip archives.
 */
export function ensureExtract(opts: ExtractOptions): string {
  const { url, sha256, cacheKey, legacyPath } = opts;
  const stripComponents = opts.stripComponents ?? 1;

  if (legacyPath && existsSync(legacyPath)) {
    return legacyPath;
  }

  const cacheRoot = process.env.XDG_CACHE_HOME
    ? join(process.env.XDG_CACHE_HOME, "wasm-posix-kernel")
    : join(homedir(), ".cache", "wasm-posix-kernel");
  const extractDir = join(cacheRoot, "vfs-build-sources", `${cacheKey}-${sha256.slice(0, 8)}`);

  if (existsSync(extractDir)) {
    return extractDir;
  }

  const archiveName = url.split("/").pop()!;
  const downloadDir = join(cacheRoot, "vfs-build-sources", "_downloads");
  mkdirSync(downloadDir, { recursive: true });
  const archivePath = join(downloadDir, archiveName);

  if (!existsSync(archivePath) || sha256OfFile(archivePath) !== sha256) {
    console.log(`==> Downloading ${url}`);
    execSync(`curl -fsSL -o "${archivePath}.partial" "${url}"`, { stdio: "inherit" });
    const got = sha256OfFile(`${archivePath}.partial`);
    if (got !== sha256) {
      rmSync(`${archivePath}.partial`, { force: true });
      throw new Error(
        `sha256 mismatch for ${archiveName}: expected ${sha256}, got ${got}`,
      );
    }
    renameSync(`${archivePath}.partial`, archivePath);
  }

  // Extract atomically: into a tmp dir, then rename. A reader (parallel
  // VFS build) won't observe a half-extracted directory.
  const tmpExtract = `${extractDir}.tmp-${process.pid}`;
  rmSync(tmpExtract, { recursive: true, force: true });
  mkdirSync(tmpExtract, { recursive: true });

  console.log(`==> Extracting ${archiveName} → ${extractDir}`);
  if (archiveName.endsWith(".zip")) {
    execSync(`unzip -q "${archivePath}" -d "${tmpExtract}"`, { stdio: "inherit" });
    if (stripComponents === 1) {
      // unzip has no --strip-components; emulate by moving children of the
      // single top-level dir up. Only handles depth=1, which covers every
      // archive we care about (WordPress.org plugin zips, etc.).
      const entries = readdirSync(tmpExtract);
      if (entries.length === 1) {
        const inner = join(tmpExtract, entries[0]);
        if (statSync(inner).isDirectory()) {
          for (const child of readdirSync(inner)) {
            renameSync(join(inner, child), join(tmpExtract, child));
          }
          rmSync(inner, { recursive: true, force: true });
        }
      }
    }
  } else {
    const flag = tarDecompressFlag(archiveName);
    execSync(
      `tar ${flag} -xf "${archivePath}" --strip-components=${stripComponents} -C "${tmpExtract}"`,
      { stdio: "inherit" },
    );
  }

  try {
    renameSync(tmpExtract, extractDir);
  } catch (e) {
    rmSync(tmpExtract, { recursive: true, force: true });
    if (!existsSync(extractDir)) throw e;
  }

  return extractDir;
}

/**
 * Sugar over `ensureExtract` for upstream sources whose URL+sha256 is
 * recorded in `examples/libs/<packageName>/package.toml`'s `[source]`
 * block. This is the right entry point for cpython, perl, mariadb,
 * nethack, wordpress — every package that already has a package.toml.
 */
export function ensureSourceExtract(
  packageName: string,
  repoRoot: string,
  legacyLocalPath?: string,
): string {
  const packageToml = join(repoRoot, "examples", "libs", packageName, "package.toml");
  const { url, sha256 } = readSourceBlock(packageToml);
  return ensureExtract({
    url,
    sha256,
    cacheKey: packageName,
    legacyPath: legacyLocalPath,
  });
}
