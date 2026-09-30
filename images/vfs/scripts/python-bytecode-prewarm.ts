/**
 * Build-time CPython bytecode prewarmer for the nginx + Python VFS image.
 *
 * WHY: On the browser host, the kernel runs in a dedicated Web Worker whose
 * V8 stack size is fixed and small — the `new Worker()` API exposes no
 * stack-size knob (host/src/worker-adapter-browser.ts). CPython compiles
 * every stdlib module from source the first time it is imported, and that
 * compile pass (tokenizer -> parser -> AST -> symtable -> code generator)
 * recurses deeply; amplified by the fork-instrument JS trampoline
 * (__wpk_fork_unwind_transport_indirect_*) that wraps each guest indirect
 * call, importing notes-app's wsgiref/http.server/email chain overflows the
 * browser worker's stack and takes the whole kernel worker down. The Node
 * host survives only because NodeKernelHost gives its worker a 32 MB stack
 * (nodeWorkerStackSizeMb() in host/src/worker-adapter.ts).
 *
 * The fix is the same shape as images/vfs/scripts/opcache-prewarm.ts does
 * for PHP: precompile the bytecode at *build* time (on the Node host, which
 * has the large stack) and bake the resulting `.pyc` files into the image.
 * At runtime the browser then loads bytecode via marshal — whose recursion
 * depth tracks code-object nesting, not source structure, and is far
 * shallower than the compiler — instead of compiling from source.
 *
 * We compile with `--invalidation-mode unchecked-hash` (PEP 552) so import
 * never revalidates the `.pyc` against its source: baking files into a VFS
 * image gives every source an mtime of "now", which would otherwise make
 * the default timestamp-based check recompile from source on first import
 * and defeat the whole prewarm. Unchecked-hash `.pyc` are used verbatim.
 *
 * Mechanism mirrors opcache-prewarm: boot a NodeKernelHost against a
 * snapshot of the half-built image, run the Kandelo CPython (magic 3.13 —
 * host python is 3.14 and would write wrong-magic `.pyc`) under the kernel
 * to (1) `compileall` the roots and (2) dump every produced `__pycache__/
 * *.pyc` back over stdout, then fold those bytes into the build's
 * MemoryFileSystem at the same VFS path the kernel saw.
 *
 * Set `KANDELO_NO_PYTHON_PREWARM=1` to skip. Failures are reported but do
 * not fail the image build unless `KANDELO_PYTHON_PREWARM_STRICT=1`.
 */
import { dirname } from "node:path";
import { NodeKernelHost } from "../../../host/src/node-kernel-host";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { writeVfsBinary, ensureDirRecursive } from "../../../host/src/vfs/image-helpers";

export interface PythonPrewarmOptions {
  /** Absolute VFS directories to compile recursively (stdlib + app). */
  sourceRoots: string[];
  /** Label used in log lines. */
  label: string;
  /** Exact staged build inputs: the Kandelo CPython and kernel wasm. */
  programs: {
    python: Uint8Array;
    kernel: Uint8Array;
  };
}

const DUMP_BEGIN = "===PYCDUMP_BEGIN===\n";
const DUMP_END = "===PYCDUMP_END===";

// PYTHONHOME points the interpreter at /usr/lib/python3.13 (the layout the
// image builder writes). HOME/TMPDIR give writable scratch. We deliberately
// do NOT set PYTHONDONTWRITEBYTECODE here: compileall must write the cache.
const PY_ENV = ["PYTHONHOME=/usr", "HOME=/tmp", "TMPDIR=/tmp", "LANG=C.UTF-8"];

/**
 * Precompile every module under `options.sourceRoots` to `.pyc` inside `fs`.
 * Mutates `fs` in place. Returns the number of `.pyc` files written. A
 * return of `0` is a soft failure — the build still works, Python just
 * compiles from source on first import (and may overflow the browser
 * worker stack, the exact gap this closes).
 */
export async function prewarmPythonBytecode(
  fs: MemoryFileSystem,
  options: PythonPrewarmOptions,
): Promise<number> {
  if (process.env.KANDELO_NO_PYTHON_PREWARM === "1") {
    console.log("[python-prewarm] skipped (KANDELO_NO_PYTHON_PREWARM=1)");
    return 0;
  }

  const { label } = options;

  try {
    console.log(`[python-prewarm:${label}] booting kernel against in-memory VFS...`);
    const imageBytes = await fs.saveImage();

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
      await host.init(exactProgramBuffer(options.programs.kernel, "prewarm kernel"));
      const pythonBytes = exactProgramBuffer(options.programs.python, "prewarm python");

      const runPhase = async (
        phase: string,
        argv: string[],
      ): Promise<{ exitCode: number; stdout: Uint8Array }> => {
        const chunks: Uint8Array[] = [];
        activeStdoutSink = (data) => chunks.push(data);
        try {
          const exitCode = await host.spawn(pythonBytes, argv, { env: PY_ENV });
          return { exitCode, stdout: concatChunks(chunks) };
        } finally {
          activeStdoutSink = null;
        }
      };

      // Phase 1: compile roots. Unchecked-hash invalidation so import uses
      // the .pyc verbatim regardless of the baked source mtime. compileall
      // returns non-zero if *any* file fails (the stdlib ships a handful of
      // intentionally un-compilable test fixtures) — that is expected and
      // does not abort the prewarm; the dump below is the real evidence.
      console.log(
        `[python-prewarm:${label}] compiling ${options.sourceRoots.join(", ")}...`,
      );
      const compile = await runPhase("compile", [
        "python3",
        "-m",
        "compileall",
        "-q",
        "--invalidation-mode",
        "unchecked-hash",
        ...options.sourceRoots,
      ]);
      if (compile.exitCode !== 0) {
        console.warn(
          `[python-prewarm:${label}] compileall exited ${compile.exitCode} ` +
            `(expected: some stdlib fixtures never compile); continuing to dump`,
        );
      }

      // Phase 2: dump every produced __pycache__/*.pyc back over stdout.
      console.log(`[python-prewarm:${label}] dumping bytecode cache files...`);
      const dump = await runPhase("dump", [
        "python3",
        "-c",
        DUMP_SCRIPT,
        ...options.sourceRoots,
      ]);
      if (dump.exitCode !== 0) {
        throw new Error(
          `[python-prewarm:${label}] dump python exited with code ${dump.exitCode}`,
        );
      }
      dumpBytes = dump.stdout;
    } finally {
      await host.destroy().catch(() => {});
    }

    const written = ingestDump(dumpBytes, fs);
    console.log(`[python-prewarm:${label}] wrote ${written} .pyc files into the image`);
    return written;
  } catch (err) {
    if (process.env.KANDELO_PYTHON_PREWARM_STRICT === "1") {
      throw err;
    }
    console.warn(
      `[python-prewarm:${label}] skipped after failure: ${summarizeError(err)}`,
    );
    return 0;
  }
}

// Walk each root for __pycache__/*.pyc and emit base64-line-framed records
// on stdout:
//   ===PYCDUMP_BEGIN===\n
//   <count>\n
//   <base64(path)>\n
//   <base64(bytes)>\n   ×count
//   ===PYCDUMP_END===\n
// STDERR carries progress; STDOUT is the structured channel (binary-safe
// via base64, ~33% overhead, irrelevant at build time).
const DUMP_SCRIPT = `
import base64, os, sys
roots = sys.argv[1:]
entries = []
for root in roots:
    for dirpath, dirnames, filenames in os.walk(root):
        if os.path.basename(dirpath) != "__pycache__":
            continue
        for name in sorted(filenames):
            if name.endswith(".pyc"):
                entries.append(os.path.join(dirpath, name))
entries.sort()
out = sys.stdout
out.write("===PYCDUMP_BEGIN===\\n")
out.write(str(len(entries)) + "\\n")
total = 0
for path in entries:
    with open(path, "rb") as fh:
        data = fh.read()
    out.write(base64.b64encode(path.encode("utf-8")).decode("ascii") + "\\n")
    out.write(base64.b64encode(data).decode("ascii") + "\\n")
    total += len(data)
out.write("===PYCDUMP_END===\\n")
out.flush()
sys.stderr.write("[python-prewarm] dumped %d pyc files, %d bytes\\n" % (len(entries), total))
`.trim();

function exactProgramBuffer(bytes: Uint8Array, label: string): ArrayBuffer {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error(`${label} input is empty`);
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function summarizeError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return (text.split("\n")[0] ?? "unknown error").trim();
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
  const text = new TextDecoder("utf-8").decode(buf);
  const beginAt = text.indexOf(DUMP_BEGIN);
  if (beginAt < 0) {
    throw new Error("[python-prewarm] PYCDUMP_BEGIN marker not found in stdout");
  }
  const body = text.substring(beginAt + DUMP_BEGIN.length);
  const lines = body.split("\n");

  const recordCount = Number.parseInt(lines[0] ?? "", 10);
  if (!Number.isFinite(recordCount)) {
    throw new Error(`[python-prewarm] bad record count: ${JSON.stringify(lines[0])}`);
  }

  let cursor = 1;
  let written = 0;
  for (let i = 0; i < recordCount; i++) {
    const pathB64 = lines[cursor++];
    const contentB64 = lines[cursor++];
    if (pathB64 == null || contentB64 == null) {
      throw new Error(`[python-prewarm] truncated record ${i}/${recordCount}`);
    }
    const path = new TextDecoder().decode(base64DecodeToBytes(pathB64));
    const content = base64DecodeToBytes(contentB64);
    ensureDirRecursive(fs, dirname(path));
    writeVfsBinary(fs, path, content, 0o644);
    written++;
  }

  const trailer = lines[cursor];
  if (trailer !== DUMP_END) {
    throw new Error(
      `[python-prewarm] missing PYCDUMP_END trailer (got: ${JSON.stringify(trailer)})`,
    );
  }
  return written;
}

function base64DecodeToBytes(b64: string): Uint8Array {
  const bin = Buffer.from(b64, "base64");
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
}
