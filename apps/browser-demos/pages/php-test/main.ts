/**
 * Browser runner for php-src PHPT tests.
 *
 * The Node/Playwright driver parses .phpt files and asks this page to run
 * transient PHP scripts inside a VFS image containing php-src test assets.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import { ensureDirRecursive, writeVfsBinary } from "@host/vfs/image-helpers";
import kernelWasmUrl from "@kernel-wasm?url";
import { rewriteRootfsLazyFileUrls } from "../../lib/init/rootfs-lazy-files";

interface RunPhpScriptRequest {
  testId: string;
  scriptPath: string;
  script: string;
  argv: string[];
  cwd: string;
  env?: string[];
  uid?: number;
  gid?: number;
  stdin?: string;
  waitForChildOutput?: boolean;
  timeoutMs?: number;
}

interface RunPhpScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output?: string;
  error?: string;
  durationMs: number;
}

declare global {
  interface Window {
    __phpTestReady: boolean;
    __runPhpScript: (request: RunPhpScriptRequest) => Promise<RunPhpScriptResult>;
  }
}

let kernelBytes: ArrayBuffer | null = null;
let vfsImageBytes: Uint8Array | null = null;
let phpBytes: ArrayBuffer | null = null;
let activeTestFs: MemoryFileSystem | null = null;
const guestWritableFileSystems = new WeakSet<MemoryFileSystem>();

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(st.size);
    let offset = 0;
    while (offset < out.length) {
      const n = fs.read(fd, out.subarray(offset), null, out.length - offset);
      if (n <= 0) break;
      offset += n;
    }
    return out.slice(0, offset);
  } finally {
    fs.close(fd);
  }
}

function createFs(): MemoryFileSystem {
  if (!vfsImageBytes) throw new Error("PHP test VFS image not loaded");
  const fs = MemoryFileSystem.fromImage(vfsImageBytes, {
    maxByteLength: 2 * 1024 * 1024 * 1024,
  });
  // This legacy shared-SAB runner registers lazy-file metadata from the
  // restored image directly, so resolve canonical rootfs placeholders to
  // Vite-managed asset URLs before BrowserKernel.init() forwards them.
  rewriteRootfsLazyFileUrls(fs);
  return fs;
}

function fsForTest(_testId: string): MemoryFileSystem {
  // php-src's native runner and the Node host keep one source tree for the
  // complete run. Preserve that lifetime so cross-test residue and broken
  // CLEAN sections remain observable instead of being hidden by a fresh VFS.
  if (!activeTestFs) activeTestFs = createFs();
  return activeTestFs;
}

function ensureParent(fs: MemoryFileSystem, path: string): void {
  const slash = path.lastIndexOf("/");
  if (slash > 0) ensureDirRecursive(fs, path.slice(0, slash));
}

function makeTreeWritableByGuest(
  fs: MemoryFileSystem,
  path: string,
): void {
  const st = fs.lstat(path);
  const kind = st.mode & 0o170000;
  if (kind === 0o120000) return;
  if (kind === 0o040000) {
    fs.chmod(path, 0o777);
    const dh = fs.opendir(path);
    try {
      for (;;) {
        const entry = fs.readdir(dh);
        if (!entry) break;
        if (entry.name === "." || entry.name === "..") continue;
        makeTreeWritableByGuest(
          fs,
          path === "/" ? `/${entry.name}` : `${path}/${entry.name}`,
        );
      }
    } finally {
      fs.closedir(dh);
    }
    return;
  }
  fs.chmod(path, (st.mode & 0o111) | 0o666);
}

function prepareGuestWritableWorkspace(
  fs: MemoryFileSystem,
  _scriptPath: string,
  uid?: number,
  gid?: number,
): void {
  if (uid == null && gid == null) return;
  if (guestWritableFileSystems.has(fs)) return;
  // Match Node's copied-source contract: directories are world-writable and
  // files retain execute bits while becoming writable. Do this once per VFS,
  // before any section mutates it.
  makeTreeWritableByGuest(fs, "/php-src");
  guestWritableFileSystems.add(fs);
}

function binaryStringToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    bytes[i] = value.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function bytesToBinaryString(data: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    out += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function init() {
  const baseUrl = import.meta.env.BASE_URL ?? "/";
  const vfsFile = import.meta.env.VITE_PHP_TEST_VFS_URL ?? "php-test.vfs.zst";
  const vfsUrl = `${baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`}${vfsFile}`;
  const [kernelBuf, imageBuf] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => {
      if (!r.ok) throw new Error(`kernel fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(vfsUrl).then((r) => {
      if (!r.ok) {
        throw new Error(
          `${vfsFile} not found (${r.status}). Run: bash images/vfs/scripts/build-php-test-vfs-image.sh`,
        );
      }
      return r.arrayBuffer();
    }),
  ]);

  kernelBytes = kernelBuf;
  vfsImageBytes = new Uint8Array(imageBuf);
  const fs = createFs();
  const php = readVfsFile(fs, "/usr/local/bin/php");
  const phpCopy = new Uint8Array(php.byteLength);
  phpCopy.set(php);
  phpBytes = phpCopy.buffer;

  window.__runPhpScript = async (request: RunPhpScriptRequest) => {
    const start = performance.now();
    // SKIPIF, FILE, and CLEAN are sections of one upstream PHPT execution and
    // must observe the same filesystem mutations. Start from a fresh image
    // only when the runner advances to a different test.
    const fs = fsForTest(request.testId);
    prepareGuestWritableWorkspace(fs, request.scriptPath, request.uid, request.gid);
    ensureParent(fs, request.scriptPath);
    let previousScript: { bytes: Uint8Array; mode: number } | null = null;
    try {
      const st = fs.lstat(request.scriptPath);
      previousScript = {
        bytes: readVfsFile(fs, request.scriptPath),
        mode: st.mode & 0o7777,
      };
    } catch {
      previousScript = null;
    }
    writeVfsBinary(fs, request.scriptPath, binaryStringToBytes(request.script), 0o644);

    let stdout = "";
    let stderr = "";
    let output = "";
    const kernel = new BrowserKernel({
      memfs: fs,
      maxWorkers: 4,
      onStdout: (data) => {
        const text = bytesToBinaryString(data);
        stdout += text;
        output += text;
      },
      onStderr: (data) => {
        const text = bytesToBinaryString(data);
        stderr += text;
        output += text;
      },
    });

    const stdin = request.stdin == null ? undefined : binaryStringToBytes(request.stdin);
    const env = [
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TEST_PHP_EXECUTABLE=/usr/local/bin/php",
      "TEST_PHP_EXECUTABLE_ESCAPED='/usr/local/bin/php'",
      ...(request.env ?? []),
    ];

    try {
      await kernel.init(kernelBytes!);
      const exitCode = await Promise.race([
        kernel.spawn(phpBytes!, ["/usr/local/bin/php", ...request.argv], {
          cwd: request.cwd,
          env,
          stdin,
          uid: request.uid,
          gid: request.gid,
        }),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), request.timeoutMs ?? 60_000),
        ),
      ]);

      if (request.waitForChildOutput) {
        const deadline = performance.now() + 1_000;
        while (performance.now() < deadline) {
          const processes = await kernel.enumProcs().catch(() => []);
          if (processes.length === 0) break;
          await delay(25);
        }
      }

      let lastOutputLength = -1;
      let stablePolls = 0;
      for (let waitedMs = 0; waitedMs < 500 && stablePolls < 3; waitedMs += 25) {
        await delay(25);
        const outputLength = output.length;
        if (waitedMs >= 100 && outputLength === lastOutputLength) {
          stablePolls++;
        } else {
          stablePolls = 0;
        }
        lastOutputLength = outputLength;
      }
      return { exitCode, stdout, stderr, output, durationMs: Math.round(performance.now() - start) };
    } catch (err: any) {
      const message = err?.message || String(err);
      return {
        exitCode: -1,
        stdout,
        stderr,
        output,
        error: message.includes("TIMEOUT") ? "TIMEOUT" : message,
        durationMs: Math.round(performance.now() - start),
      };
    } finally {
      await kernel.destroy().catch(() => {});
      if (previousScript) {
        writeVfsBinary(
          fs,
          request.scriptPath,
          previousScript.bytes,
          previousScript.mode,
        );
        fs.chmod(request.scriptPath, previousScript.mode);
      } else {
        try {
          fs.unlink(request.scriptPath);
        } catch {
          // The guest may already have removed its generated script.
        }
      }
    }
  };

  window.__phpTestReady = true;
  document.getElementById("status")!.textContent = "Ready";
}

init().catch((err) => {
  console.error(err);
  document.getElementById("status")!.textContent = `Error: ${err?.message || err}`;
});
