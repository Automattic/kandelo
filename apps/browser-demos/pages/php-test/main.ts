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

interface RunPhpScriptRequest {
  scriptPath: string;
  script: string;
  argv: string[];
  cwd: string;
  env?: string[];
  uid?: number;
  gid?: number;
  stdin?: string;
  stdinIsPipe?: boolean;
  pipeStdio?: number[];
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
  return MemoryFileSystem.fromImage(vfsImageBytes, {
    maxByteLength: 2 * 1024 * 1024 * 1024,
  });
}

function ensureParent(fs: MemoryFileSystem, path: string): void {
  const slash = path.lastIndexOf("/");
  if (slash > 0) ensureDirRecursive(fs, path.slice(0, slash));
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "/";
}

function makeDirectoryWritableByGuest(
  fs: MemoryFileSystem,
  path: string,
  uid: number,
  gid: number,
): void {
  try {
    const st = fs.lstat(path);
    // The harness prepares an ephemeral php-src image per PHPT section.
    // When the guest process intentionally runs as a non-root uid, make the
    // source root and the current PHPT directory writable by that guest just
    // like the Node-host harness does for copied source trees. This changes
    // only test fixture ownership/mode; kernel credential checks still decide
    // whether user-mode operations are allowed.
    if ((st.mode & 0o170000) !== 0o040000) return;
    fs.chown(path, uid, gid);
    fs.chmod(path, 0o777);
  } catch {
    // Missing paths will be reported by the actual PHP process or by the
    // script write below. This helper is best-effort fixture setup.
  }
}

function prepareGuestWritableWorkspace(
  fs: MemoryFileSystem,
  scriptPath: string,
  uid?: number,
  gid?: number,
): void {
  if (uid == null && gid == null) return;
  const effectiveUid = uid ?? 0;
  const effectiveGid = gid ?? effectiveUid;
  makeDirectoryWritableByGuest(fs, "/php-src", effectiveUid, effectiveGid);
  makeDirectoryWritableByGuest(
    fs,
    parentPath(scriptPath),
    effectiveUid,
    effectiveGid,
  );
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

function corsProxyUrlPrefix(): string {
  const base = import.meta.env.BASE_URL ?? "/";
  const normalized = base.startsWith("/") ? base : `/${base}`;
  const proxyPath = `${normalized.endsWith("/") ? normalized : `${normalized}/`}__kandelo_cors_proxy`;
  const proxyUrl = new URL(proxyPath, window.location.href);
  proxyUrl.searchParams.set("url", "");
  return proxyUrl.href;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function init() {
  const [kernelBuf, imageBuf] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => {
      if (!r.ok) throw new Error(`kernel fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch("/php-test.vfs.zst").then((r) => {
      if (!r.ok) {
        throw new Error(
          `php-test.vfs.zst not found (${r.status}). Run: bash images/vfs/scripts/build-php-test-vfs-image.sh`,
        );
      }
      return r.arrayBuffer();
    }),
  ]);

  kernelBytes = kernelBuf;
  vfsImageBytes = new Uint8Array(imageBuf);
  const fs = createFs();
  const php = readVfsFile(fs, "/usr/local/bin/php");
  phpBytes = php.buffer.slice(php.byteOffset, php.byteOffset + php.byteLength);

  window.__runPhpScript = async (request: RunPhpScriptRequest) => {
    const start = performance.now();
    const fs = createFs();
    prepareGuestWritableWorkspace(fs, request.scriptPath, request.uid, request.gid);
    ensureParent(fs, request.scriptPath);
    writeVfsBinary(fs, request.scriptPath, binaryStringToBytes(request.script), 0o644);

    let stdout = "";
    let stderr = "";
    let output = "";
    const kernel = new BrowserKernel({
      memfs: fs,
      maxWorkers: 4,
      corsProxyUrl: corsProxyUrlPrefix(),
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
          stdinIsPipe: request.stdinIsPipe,
          pipeStdio: request.pipeStdio,
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
    }
  };

  window.__phpTestReady = true;
  document.getElementById("status")!.textContent = "Ready";
}

init().catch((err) => {
  console.error(err);
  document.getElementById("status")!.textContent = `Error: ${err?.message || err}`;
});
