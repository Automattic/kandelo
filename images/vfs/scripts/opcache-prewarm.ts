/**
 * Build-time opcache prewarmer for PHP VFS images.
 *
 * Boots a `NodeKernelHost` against the half-built VFS image, runs PHP CLI
 * with `opcache.file_cache_only=1` pointed at `/var/cache/opcache`, asks
 * it to `opcache_compile_file()` every `.php` under the configured source
 * roots, then dumps the resulting cache files back over stdout. Each
 * dumped file is written into the build's MemoryFileSystem at the same
 * VFS path the kernel saw, so when the demo boots its FPM workers pick
 * up the cache without paying the first-request compile cost.
 *
 * Compilation is batched across multiple PHP CLI spawns sharing the
 * same kernel-managed memfs. Empirically the wasm PHP CLI traps
 * around ~950 cumulative opcache_compile_file() calls in a single
 * process (issue #493 — root cause unknown; opcache_reset() does
 * not help, so it is not the per-process script table). Splitting
 * into batches of 500 stays well below that ceiling. A final
 * "dump" spawn walks the cache directory and base64-encodes each
 * .bin back over stdout for the host to ingest.
 *
 * Why the stdout round-trip:
 *   The kernel boots from a *snapshot* of the build's memfs — anything
 *   PHP writes lands in the kernel's private copy, not the build's. We
 *   either snapshot the kernel's memfs back out (no API for that today)
 *   or stream the new files over a channel we already have. stdout is
 *   that channel. The protocol is base64-line-framed because raw
 *   binary writes to STDOUT trap the wasm PHP CLI (a `pack('J', …)`
 *   word kills the process the moment it hits php://stdout — likely
 *   an internal text-mode assertion):
 *     ===OCDUMP_BEGIN===\n
 *     <count>\n
 *     <base64(path)>\n
 *     <base64(content)>\n  ×count
 *     ===OCDUMP_END===\n
 *   ~33% overhead, irrelevant at build time, fully binary-safe.
 *
 * Set `KANDELO_NO_OPCACHE_PREWARM=1` to skip; the build still produces a
 * working image, just without the first-request hit.
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { NodeKernelHost } from "../../../host/src/node-kernel-host";
import { resolveBinary } from "../../../host/src/binary-resolver";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { writeVfsBinary, ensureDirRecursive } from "../../../host/src/vfs/image-helpers";

export interface OpcachePrewarmOptions {
  /** Absolute VFS paths to walk for `.php` files. */
  sourceRoots: string[];
  /** Label used in log lines. */
  label: string;
}

// Must match the `opcache.file_cache=` setting in each demo's runtime
// php.ini — runtime FPM reads cache files from the same VFS path the
// prewarm dump wrote them to.
const CACHE_DIR = "/var/cache/opcache";

const DUMP_BEGIN = "===OCDUMP_BEGIN===\n";
const LIST_BEGIN = "===PHPLIST_BEGIN===\n";
const LIST_END = "===PHPLIST_END===\n";

// Per-spawn compilation cap. The wasm PHP CLI traps around ~950
// cumulative opcache_compile_file() calls in a single process (issue
// #493 — exit -1 with no diagnostic; opcache_reset() doesn't help so it
// isn't the per-process script table, and the offending file compiles
// fine in isolation). 500 leaves plenty of headroom.
const COMPILE_BATCH_SIZE = 500;

const PHP_INI_ARGS = [
  "-d", "extension_dir=/usr/lib/php/extensions",
  "-d", "zend_extension=opcache",
  "-d", "opcache.enable=1",
  "-d", "opcache.enable_cli=1",
  "-d", "opcache.file_cache_only=1",
  "-d", `opcache.file_cache=${CACHE_DIR}`,
  // file_update_protection defaults to 2s; opcache refuses to cache
  // any file whose mtime is within that window. Every PHP file we
  // walk was just written into the in-memory VFS by this build, so
  // their mtimes are all "now" — we'd cache nothing without this.
  "-d", "opcache.file_update_protection=0",
  "-d", "memory_limit=512M",
];

const PHP_ENV = ["HOME=/tmp", "TMPDIR=/tmp"];

/**
 * Pre-populate the opcache file cache inside `fs` by compiling every
 * `.php` under `options.sourceRoots`. Mutates `fs` in place. Returns the
 * number of cache files written. A return of `0` is a soft failure —
 * the build still works, opcache just runs cold on first request.
 */
export async function prewarmOpcache(
  fs: MemoryFileSystem,
  options: OpcachePrewarmOptions,
): Promise<number> {
  if (process.env.KANDELO_NO_OPCACHE_PREWARM === "1") {
    console.log("[opcache-prewarm] skipped (KANDELO_NO_OPCACHE_PREWARM=1)");
    return 0;
  }

  const { label } = options;

  ensureDirRecursive(fs, CACHE_DIR);

  console.log(`[opcache-prewarm:${label}] booting kernel against in-memory VFS...`);
  const imageBytes = await fs.saveImage();

  // SpawnOptions has no per-call onStdout, so a single host-level
  // callback delegates to whichever phase is currently running.
  let activeStdoutSink: ((data: Uint8Array) => void) | null = null;
  const host = new NodeKernelHost({
    rootfsImage: imageBytes,
    onStdout: (_pid, data) => {
      activeStdoutSink?.(new Uint8Array(data));
    },
    onStderr: (_pid, data) => {
      process.stderr.write(data);
    },
  });

  let dumpBytes: Uint8Array;
  try {
    await host.init();
    const phpPath = resolveBinary("programs/php/php.wasm");
    const phpBytes = readFileSync(phpPath);
    const programBytes = phpBytes.buffer.slice(
      phpBytes.byteOffset,
      phpBytes.byteOffset + phpBytes.byteLength,
    ) as ArrayBuffer;

    const runPhase = async (phase: string, job: PhpJob): Promise<Uint8Array> => {
      const chunks: Uint8Array[] = [];
      activeStdoutSink = (data) => chunks.push(data);
      try {
        const exitCode = await host.spawn(
          programBytes,
          ["php", ...PHP_INI_ARGS, "-r", buildJobScript(job)],
          { env: PHP_ENV },
        );
        if (exitCode !== 0) {
          throw new Error(
            `[opcache-prewarm:${label}] ${phase} php exited with code ${exitCode}`,
          );
        }
      } finally {
        activeStdoutSink = null;
      }
      return concatChunks(chunks);
    };

    // Phase 1: list every .php under the roots so the host can batch.
    console.log(`[opcache-prewarm:${label}] listing .php files...`);
    const listBytes = await runPhase("list", { kind: "list", roots: options.sourceRoots });
    const phpPaths = parseList(listBytes);
    console.log(`[opcache-prewarm:${label}] ${phpPaths.length} php files to compile`);

    // Phase 2: compile in batches; each spawn resets process memory but
    // writes through to the shared kernel memfs cache dir.
    const batches = Math.ceil(phpPaths.length / COMPILE_BATCH_SIZE);
    for (let i = 0; i < batches; i++) {
      const slice = phpPaths.slice(i * COMPILE_BATCH_SIZE, (i + 1) * COMPILE_BATCH_SIZE);
      console.log(
        `[opcache-prewarm:${label}] batch ${i + 1}/${batches} (${slice.length} files)`,
      );
      await runPhase(`compile-${i + 1}`, { kind: "compile", files: slice });
    }

    // Phase 3: dump the populated /var/cache/opcache back over stdout.
    console.log(`[opcache-prewarm:${label}] dumping cache files...`);
    dumpBytes = await runPhase("dump", { kind: "dump" });
  } finally {
    await host.destroy().catch(() => {});
  }

  const written = ingestDump(dumpBytes, fs);
  console.log(`[opcache-prewarm:${label}] wrote ${written} cache files into ${CACHE_DIR}`);
  return written;
}

type PhpJob =
  | { kind: "list"; roots: string[] }
  | { kind: "compile"; files: string[] }
  | { kind: "dump" };

function buildJobScript(job: PhpJob): string {
  // Each job script:
  //   - list:    walk roots, emit ===PHPLIST_BEGIN===\n<path>\n…<path>\n===PHPLIST_END===
  //   - compile: opcache_compile_file() each path in the embedded list
  //   - dump:    walk cacheDir, emit ===OCDUMP_BEGIN=== framing
  // STDERR carries human-readable progress; STDOUT is the structured channel.
  if (job.kind === "list") {
    return `
$roots = json_decode(${JSON.stringify(JSON.stringify(job.roots))}, true);
echo "===PHPLIST_BEGIN===\\n";
$count = 0;
foreach ($roots as $root) {
    if (!is_dir($root)) { fwrite(STDERR, "[prewarm] skip missing root $root\\n"); continue; }
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($it as $f) {
        if (!$f->isFile()) continue;
        if (strtolower($f->getExtension()) !== 'php') continue;
        echo base64_encode($f->getPathname()) . "\\n";
        $count++;
    }
}
echo "===PHPLIST_END===\\n";
fwrite(STDERR, "[prewarm] listed $count php files\\n");
`.trim();
  }

  if (job.kind === "compile") {
    return `
if (!extension_loaded('Zend OPcache')) {
    fwrite(STDERR, "[prewarm] FATAL: opcache extension not loaded\\n");
    exit(1);
}
$files = json_decode(${JSON.stringify(JSON.stringify(job.files))}, true);
$compiled = 0; $failed = 0;
foreach ($files as $path) {
    $ok = @opcache_compile_file($path);
    if ($ok) { $compiled++; } else { $failed++; }
}
fwrite(STDERR, "[prewarm] batch compiled=$compiled failed=$failed\\n");
`.trim();
  }

  // dump
  return `
$cacheDir = ${JSON.stringify(CACHE_DIR)};
$entries = [];
if (is_dir($cacheDir)) {
    $it = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($cacheDir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::LEAVES_ONLY
    );
    foreach ($it as $f) {
        if ($f->isFile()) { $entries[] = $f->getPathname(); }
    }
}
// base64-encoded line records — raw binary writes to php://stdout
// trap the wasm PHP CLI (any pack('J', ...) kills the process with
// exit 255 the moment binary hits stdout; likely a CLI output-buffer
// assertion). ~33% overhead, irrelevant at build time.
echo "===OCDUMP_BEGIN===\\n";
echo count($entries) . "\\n";
$bytes = 0;
foreach ($entries as $path) {
    $contents = @file_get_contents($path);
    if ($contents === false) {
        fwrite(STDERR, "[prewarm] read failed: $path\\n");
        $contents = '';
    }
    echo base64_encode($path) . "\\n";
    echo base64_encode($contents) . "\\n";
    $bytes += strlen($contents);
}
echo "===OCDUMP_END===\\n";
fwrite(STDERR, "[prewarm] dumped " . count($entries) . " cache files, $bytes bytes\\n");
`.trim();
}

function parseList(buf: Uint8Array): string[] {
  const text = new TextDecoder("utf-8").decode(buf);
  const beginAt = text.indexOf(LIST_BEGIN);
  if (beginAt < 0) {
    throw new Error("[opcache-prewarm] PHPLIST_BEGIN marker not found");
  }
  const body = text.substring(beginAt + LIST_BEGIN.length);
  const endAt = body.indexOf(LIST_END);
  if (endAt < 0) {
    throw new Error("[opcache-prewarm] PHPLIST_END marker not found");
  }
  return body
    .substring(0, endAt)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((b64) => new TextDecoder().decode(base64DecodeToBytes(b64)));
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function ingestDump(buf: Uint8Array, fs: MemoryFileSystem): number {
  // Decode the entire buffer as UTF-8 (it's now all base64 + ASCII
  // framing). Locate the begin marker line, then read line-pairs:
  //   <count>\n
  //   <base64-path>\n
  //   <base64-content>\n
  //   ... ×count ...
  //   ===OCDUMP_END===\n
  // Anything before the begin marker is stderr leakage or PHP-warning
  // noise and is ignored.
  const text = new TextDecoder("utf-8").decode(buf);
  const beginAt = text.indexOf(DUMP_BEGIN);
  if (beginAt < 0) {
    throw new Error("[opcache-prewarm] OCDUMP_BEGIN marker not found in stdout");
  }
  const body = text.substring(beginAt + DUMP_BEGIN.length);
  const lines = body.split("\n");

  const recordCount = Number.parseInt(lines[0] ?? "", 10);
  if (!Number.isFinite(recordCount)) {
    throw new Error(`[opcache-prewarm] bad record count: ${JSON.stringify(lines[0])}`);
  }

  let cursor = 1;
  for (let i = 0; i < recordCount; i++) {
    const pathB64 = lines[cursor++];
    const contentB64 = lines[cursor++];
    if (pathB64 == null || contentB64 == null) {
      throw new Error(`[opcache-prewarm] truncated record ${i}/${recordCount}`);
    }
    const path = new TextDecoder().decode(base64DecodeToBytes(pathB64));
    const content = base64DecodeToBytes(contentB64);
    if (content.byteLength === 0) continue;
    ensureDirRecursive(fs, dirname(path));
    writeVfsBinary(fs, path, content, 0o644);
  }

  const trailer = lines[cursor];
  if (trailer !== "===OCDUMP_END===") {
    throw new Error(
      `[opcache-prewarm] missing OCDUMP_END trailer (got: ${JSON.stringify(trailer)})`,
    );
  }
  return recordCount;
}

function base64DecodeToBytes(b64: string): Uint8Array {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}
