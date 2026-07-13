/**
 * Browser runner for php-src PHPT tests.
 *
 * The Node/Playwright driver parses .phpt files and asks this page to run
 * transient PHP scripts inside a VFS image containing php-src test assets.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import kernelWasmUrl from "@kernel-wasm?url";
import { finalizeKernelOwnedImage } from "../../lib/kernel-owned-boot";
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
let initialFs: MemoryFileSystem | null = null;
let kernel: BrowserKernel | null = null;
let kernelInitialization: Promise<BrowserKernel> | null = null;
let activeOutput: { stdout: string; stderr: string; output: string } | null = null;

function createFs(vfsImageBytes: Uint8Array): MemoryFileSystem {
  const fs = MemoryFileSystem.fromImage(vfsImageBytes, {
    maxByteLength: 2 * 1024 * 1024 * 1024,
  });
  // Resolve canonical rootfs placeholders before serializing the transient
  // build FS into the image that the kernel worker will own.
  rewriteRootfsLazyFileUrls(fs);
  return fs;
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
  // Match Node's copied-source contract: directories are world-writable and
  // files retain execute bits while becoming writable. Do this once per VFS,
  // before any section mutates it.
  makeTreeWritableByGuest(fs, "/php-src");
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

async function ensureKernel(uid?: number, gid?: number): Promise<BrowserKernel> {
  if (kernel) return kernel;
  if (kernelInitialization) return kernelInitialization;

  kernelInitialization = (async () => {
    if (!initialFs || !kernelBytes) {
      throw new Error("PHP test runtime is not initialized");
    }
    const buildFs = initialFs;
    prepareGuestWritableWorkspace(buildFs, "/php-src", uid, gid);
    const vfsImage = await finalizeKernelOwnedImage(buildFs);
    const nextKernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 4,
      onStdout: (data) => {
        if (!activeOutput) return;
        const text = bytesToBinaryString(data);
        activeOutput.stdout += text;
        activeOutput.output += text;
      },
      onStderr: (data) => {
        if (!activeOutput) return;
        const text = bytesToBinaryString(data);
        activeOutput.stderr += text;
        activeOutput.output += text;
      },
    });
    try {
      await nextKernel.initFromImage({
        kernelWasm: kernelBytes,
        vfsImage,
      });
    } catch (err) {
      await nextKernel.destroy().catch(() => {});
      throw err;
    }
    // The worker now owns the live VFS. Drop the transient main-thread build
    // filesystem so browser memory reclamation does not depend on page GC.
    initialFs = null;
    kernel = nextKernel;
    return nextKernel;
  })();

  try {
    return await kernelInitialization;
  } finally {
    kernelInitialization = null;
  }
}

async function terminateRemainingProcesses(runtime: BrowserKernel): Promise<void> {
  const processes = await runtime.enumProcs();
  if (processes.length === 0) return;
  const results = await Promise.allSettled(
    processes.map((process) => runtime.terminateProcess(process.pid)),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
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
  const fs = createFs(new Uint8Array(imageBuf));
  const php = fs.stat("/usr/local/bin/php");
  if ((php.mode & 0o170000) !== 0o100000) {
    throw new Error("PHP test VFS does not contain a regular /usr/local/bin/php");
  }
  initialFs = fs;

  window.__runPhpScript = async (request: RunPhpScriptRequest) => {
    const start = performance.now();
    const capture = { stdout: "", stderr: "", output: "" };
    if (activeOutput) {
      return {
        exitCode: -1,
        ...capture,
        error: "Concurrent browser PHPT sections are not supported",
        durationMs: Math.round(performance.now() - start),
      };
    }
    let runtime: BrowserKernel | null = null;
    let previousScript: Awaited<ReturnType<BrowserKernel["readFileSnapshotFromVfs"]>> = null;
    let scriptStaged = false;
    let timeoutId: number | undefined;
    let result: RunPhpScriptResult | null = null;
    const stdin = request.stdin == null
      ? new Uint8Array()
      : binaryStringToBytes(request.stdin);
    const env = [
      "HOME=/tmp",
      "TMPDIR=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TEST_PHP_EXECUTABLE=/usr/local/bin/php",
      "TEST_PHP_EXECUTABLE_ESCAPED='/usr/local/bin/php'",
      ...(request.env ?? []),
    ];

    try {
      runtime = await ensureKernel(request.uid, request.gid);
      // The worker owns one persistent PHPT workspace for the page lifetime.
      // This matches the Node runner's mounted source tree: SKIPIF, FILE,
      // CLEAN, and later tests all observe guest mutations and failed cleanup.
      previousScript = await runtime.readFileSnapshotFromVfs(request.scriptPath);
      await runtime.writeFileToVfs(
        request.scriptPath,
        binaryStringToBytes(request.script),
        0o644,
      );
      scriptStaged = true;
      activeOutput = capture;

      const spawned = await runtime.spawnFromVfs(
        "/usr/local/bin/php",
        ["/usr/local/bin/php", ...request.argv],
        {
          cwd: request.cwd,
          env,
          stdin,
          uid: request.uid,
          gid: request.gid,
        },
      );
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new Error("TIMEOUT")),
          request.timeoutMs ?? 60_000,
        );
      });
      const exitCode = await Promise.race([spawned.exit, timeout]);

      if (request.waitForChildOutput) {
        const deadline = performance.now() + 1_000;
        while (performance.now() < deadline) {
          const processes = await runtime.enumProcs().catch(() => []);
          if (processes.length === 0) break;
          await delay(25);
        }
      }

      let lastOutputLength = -1;
      let stablePolls = 0;
      for (let waitedMs = 0; waitedMs < 500 && stablePolls < 3; waitedMs += 25) {
        await delay(25);
        const outputLength = capture.output.length;
        if (waitedMs >= 100 && outputLength === lastOutputLength) {
          stablePolls++;
        } else {
          stablePolls = 0;
        }
        lastOutputLength = outputLength;
      }
      result = {
        exitCode,
        ...capture,
        durationMs: 0,
      };
    } catch (err: any) {
      const message = err?.message || String(err);
      result = {
        exitCode: -1,
        ...capture,
        error: message.includes("TIMEOUT") ? "TIMEOUT" : message,
        durationMs: 0,
      };
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      let cleanupError: unknown = null;
      if (runtime) {
        try {
          // Upstream runs each PHP invocation in an isolated process tree.
          // Preserve the worker-owned VFS, but do not let orphaned children
          // leak into the next PHPT section.
          await terminateRemainingProcesses(runtime);
        } catch (err) {
          cleanupError = err;
        }
        if (scriptStaged) {
          try {
            if (previousScript) {
              await runtime.writeFileToVfs(
                request.scriptPath,
                previousScript.data,
                previousScript.mode,
              );
            } else {
              await runtime.unlinkFileFromVfs(request.scriptPath);
            }
          } catch (err) {
            cleanupError ??= err;
          }
        }
      }
      if (activeOutput === capture) activeOutput = null;
      if (cleanupError && result) {
        const message = cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
        result.exitCode = -1;
        result.error = result.error
          ? `${result.error}; PHPT cleanup failed: ${message}`
          : `PHPT cleanup failed: ${message}`;
      }
    }
    result ??= {
      exitCode: -1,
      ...capture,
      error: "PHP browser runner produced no result",
      durationMs: 0,
    };
    result.durationMs = Math.round(performance.now() - start);
    return result;
  };

  window.__phpTestReady = true;
  document.getElementById("status")!.textContent = "Ready";
}

init().catch((err) => {
  console.error(err);
  document.getElementById("status")!.textContent = `Error: ${err?.message || err}`;
});
