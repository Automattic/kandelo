/**
 * Browser runner for SQLite's upstream Tcl-based testfixture suite.
 *
 * Exposes window.__runSqliteTest("select1.test", timeoutMs) for Playwright.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { MemoryFileSystem } from "@host/vfs/memory-fs";
import { writeVfsFile } from "@host/vfs/image-helpers";
import kernelWasmUrl from "@kernel-wasm?url";

declare global {
  interface Window {
    __sqliteTestReady: boolean;
    __runSqliteTest: (testFile: string, timeoutMs?: number) => Promise<SqliteTestResult>;
    __runSqliteCommand: (argv: string[], timeoutMs?: number, options?: SqliteRunOptions) => Promise<SqliteTestResult>;
    __sqliteArtifactSnapshot?: (snapshot: SqliteArtifactSnapshot) => void | Promise<void>;
  }
}

interface SqliteRunOptions {
  uid?: number;
  gid?: number;
}

interface SqliteTestResult {
  test: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
  artifacts?: Array<{
    path: string;
    base64: string;
  }>;
}

interface SqliteArtifactSnapshot {
  durationMs: number;
  artifacts?: SqliteTestResult["artifacts"];
}

let kernelBytes: ArrayBuffer | null = null;
let vfsImageBytes: Uint8Array | null = null;
let testfixtureBytes: ArrayBuffer | null = null;

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

function tryReadVfsFile(fs: MemoryFileSystem, path: string): Uint8Array | null {
  try {
    return readVfsFile(fs, path);
  } catch {
    return null;
  }
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function collectArtifacts(fs: MemoryFileSystem): SqliteTestResult["artifacts"] {
  const artifacts: NonNullable<SqliteTestResult["artifacts"]> = [];
  for (const path of [
    "/sqlite/testrunner.db",
    "/sqlite/testrunner.db-journal",
    "/sqlite/testrunner.db-shm",
    "/sqlite/testrunner.db-wal",
    "/sqlite/testrunner.log",
    "/sqlite/testrunner_build.log",
  ]) {
    const bytes = tryReadVfsFile(fs, path);
    if (bytes) artifacts.push({ path, base64: base64Encode(bytes) });
  }
  return artifacts.length > 0 ? artifacts : undefined;
}

function createFs(): MemoryFileSystem {
  if (!vfsImageBytes) throw new Error("SQLite test VFS image not loaded");
  const fs = MemoryFileSystem.fromImage(vfsImageBytes, {
    maxByteLength: 512 * 1024 * 1024,
  });
  fs.chmod("/sqlite", 0o777);
  fs.chmod("/tmp", 0o777);
  try {
    fs.chmod("/sqlite/testdir", 0o777);
  } catch {}
  return fs;
}

function sqliteSyscallLogPtrWidth(): 4 | 8 | undefined {
  const value = import.meta.env.VITE_SQLITE_BROWSER_SYSCALL_LOG_PTR_WIDTH;
  if (value === "4") return 4;
  if (value === "8") return 8;
  return undefined;
}

async function init() {
  const [kernelBuf, imageBuf] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => {
      if (!r.ok) throw new Error(`kernel fetch failed: ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch("/sqlite-test.vfs.zst").then((r) => {
      if (!r.ok) {
        throw new Error(
          `sqlite-test.vfs.zst not found (${r.status}). Run: bash images/vfs/scripts/build-sqlite-test-vfs-image.sh`,
        );
      }
      return r.arrayBuffer();
    }),
  ]);

  kernelBytes = kernelBuf;
  vfsImageBytes = new Uint8Array(imageBuf);
  const fs = createFs();
  const fixture = readVfsFile(fs, "/usr/bin/testfixture");
  testfixtureBytes = new ArrayBuffer(fixture.byteLength);
  new Uint8Array(testfixtureBytes).set(fixture);

  async function runSqlite(argv: string[], label: string, timeoutMs = 180_000, options: SqliteRunOptions = {}): Promise<SqliteTestResult> {
    const start = performance.now();
    let stdout = "";
    let stderr = "";
    let lastProgressLogMs = 0;
    const appendStdout = (text: string) => {
      stdout += text;
      const now = performance.now();
      if (now - lastProgressLogMs < 5000) return;
      lastProgressLogMs = now;
      const lines = stdout.split(/\r|\n/).map((line) => line.trim()).filter(Boolean);
      const line = lines.at(-1);
      if (line) console.info(`[sqlite-progress] ${line}`);
    };
    const fs = createFs();
    const readArtifacts = () => collectArtifacts(fs);
    const publishArtifactSnapshot = async (artifacts = readArtifacts()) => {
      const sink = window.__sqliteArtifactSnapshot;
      if (!sink) return;
      await Promise.resolve(sink({
        durationMs: Math.round(performance.now() - start),
        artifacts,
      })).catch(() => {});
    };
    const artifactTimer = window.setInterval(() => {
      void publishArtifactSnapshot();
    }, 5000);
    if (argv[1] === "kandelo-testrunner.tcl") {
      writeVfsFile(fs, "/sqlite/kandelo-testrunner.tcl", [
        "set ::tcl_platform(os) OpenBSD",
        "set ::tcl_platform(platform) unix",
        "set argv0 test/testrunner.tcl",
        "source $argv0",
        "",
      ].join("\n"), 0o644);
    }
    const kernel = new BrowserKernel({
      memfs: fs,
      maxWorkers: 4,
      enableSyscallLog: import.meta.env.VITE_SQLITE_BROWSER_SYSCALL_LOG === "1",
      syscallLogPtrWidth: sqliteSyscallLogPtrWidth(),
      onStdout: (data) => { appendStdout(new TextDecoder().decode(data)); },
      onStderr: (data) => { stderr += new TextDecoder().decode(data); },
    });

    let exitCode = -1;
    let error: string | undefined;
    try {
      await kernel.init(kernelBytes!);
      const textDecoder = new TextDecoder();
      exitCode = await Promise.race([
        kernel.spawn(testfixtureBytes!, argv, {
          cwd: "/sqlite",
          uid: options.uid,
          gid: options.gid,
          env: [
            "HOME=/tmp",
            "TMPDIR=/tmp",
            "TCL_LIBRARY=/usr/lib/tcl8.6",
            "PATH=/usr/bin:/bin",
          ],
          pty: true,
          stdin: new Uint8Array(0),
          onStarted: (pid) => {
            kernel.onPtyOutput(pid, (data) => {
              appendStdout(textDecoder.decode(data));
            });
          },
        }),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
        ),
      ]);
    } catch (err: any) {
      const message = err?.message || String(err);
      error = message.includes("TIMEOUT") ? "TIMEOUT" : message;
    } finally {
      window.clearInterval(artifactTimer);
      await kernel.destroy().catch(() => {});
    }
    const artifacts = readArtifacts();
    await publishArtifactSnapshot(artifacts);
    return {
      test: label,
      exitCode,
      stdout,
      stderr,
      error,
      durationMs: Math.round(performance.now() - start),
      artifacts,
    };
  }

  window.__runSqliteTest = async (testFile: string, timeoutMs = 180_000) => {
    return runSqlite(["testfixture", `test/${testFile}`], testFile, timeoutMs);
  };

  window.__runSqliteCommand = async (argv: string[], timeoutMs = 180_000, options: SqliteRunOptions = {}) => {
    return runSqlite(argv, argv.join(" "), timeoutMs, options);
  };

  window.__sqliteTestReady = true;
  document.getElementById("status")!.textContent = "Ready";
}

init().catch((err) => {
  console.error(err);
  document.getElementById("status")!.textContent = `Error: ${err?.message || err}`;
});
