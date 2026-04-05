/**
 * Browser test runner — runs individual wasm test programs via BrowserKernel.
 *
 * Exposes window.__runTest(wasmBytes) for Playwright to call.
 * Each call creates a fresh BrowserKernel, runs the program, cleans up,
 * and returns { exitCode, stdout, stderr }.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import dashWasmUrl from "../../../../examples/libs/dash/bin/dash.wasm?url";
import coreutilsWasmUrl from "../../../../examples/libs/coreutils/bin/coreutils.wasm?url";
import grepWasmUrl from "../../../../examples/libs/grep/bin/grep.wasm?url";
import sedWasmUrl from "../../../../examples/libs/sed/bin/sed.wasm?url";
import genCatWasmUrl from "../../../../examples/gencat.wasm?url";

interface DataFile {
  path: string;
  data?: number[]; // byte array (transferred as JSON-safe array)
  useWasmBytes?: boolean; // if true, use the wasmBytes as file content
}

declare global {
  interface Window {
    __testRunnerReady: boolean;
    __runTest: (
      wasmBytes: ArrayBuffer,
      argv?: string[],
      timeoutMs?: number,
      options?: { dataFiles?: DataFile[]; cwd?: string; env?: string[] },
    ) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
    __testCount: number;
  }
}

// --- Tool binaries (pre-fetched at init) ---
let kernelWasmBytes: ArrayBuffer | null = null;
let dashBytes: ArrayBuffer | null = null;
let coreutilsBytes: ArrayBuffer | null = null;
let grepBytes: ArrayBuffer | null = null;
let sedBytes: ArrayBuffer | null = null;
let genCatBytes: ArrayBuffer | null = null;

const COREUTILS_NAMES = [
  "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
  "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "cp",
  "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname",
  "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
  "fold", "groups", "head", "hostid", "id", "install", "join", "link",
  "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
  "mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste",
  "pathchk", "pr", "printenv", "printf", "ptx", "pwd", "readlink",
  "realpath", "rm", "rmdir", "runcon", "seq", "sha1sum", "sha224sum",
  "sha256sum", "sha384sum", "sha512sum", "shred", "shuf", "sleep",
  "sort", "split", "stat", "stty", "sum", "sync", "tac", "tail",
  "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort",
  "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc", "whoami",
  "yes",
];

/** Resolve an exec path to a known tool binary. */
function resolveToolExec(path: string): ArrayBuffer | null {
  const name = path.split("/").pop()!;
  if (dashBytes && (name === "sh" || name === "dash")) return dashBytes;
  if (grepBytes && (name === "grep" || name === "egrep" || name === "fgrep")) return grepBytes;
  if (sedBytes && name === "sed") return sedBytes;
  if (genCatBytes && name === "gencat") return genCatBytes;
  if (coreutilsBytes && (COREUTILS_NAMES.includes(name) || name === "[")) return coreutilsBytes;
  return null;
}

/** Populate VFS with executable stubs for PATH-based lookup. */
function populateExecStubs(fs: import("../../lib/browser-kernel").BrowserKernel["fs"]): void {
  for (const dir of ["/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin"]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }
  const commands: string[] = ["sh", "dash", ...COREUTILS_NAMES, "["];
  if (grepBytes) commands.push("grep", "egrep", "fgrep");
  if (sedBytes) commands.push("sed");
  if (genCatBytes) commands.push("gencat");
  for (const name of commands) {
    for (const dir of ["/bin", "/usr/bin"]) {
      try {
        const fd = fs.open(`${dir}/${name}`, 0o101 /* O_WRONLY|O_CREAT */, 0o755);
        fs.close(fd);
      } catch { /* exists */ }
    }
  }
}

async function init() {
  // Fetch kernel wasm and tool binaries in parallel
  const fetches = await Promise.allSettled([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(dashWasmUrl).then((r) => r.arrayBuffer()),
    fetch(coreutilsWasmUrl).then((r) => r.arrayBuffer()),
    fetch(grepWasmUrl).then((r) => r.arrayBuffer()),
    fetch(sedWasmUrl).then((r) => r.arrayBuffer()),
    fetch(genCatWasmUrl).then((r) => r.arrayBuffer()),
  ]);
  kernelWasmBytes = fetches[0].status === "fulfilled" ? fetches[0].value : null;
  dashBytes = fetches[1].status === "fulfilled" ? fetches[1].value : null;
  coreutilsBytes = fetches[2].status === "fulfilled" ? fetches[2].value : null;
  grepBytes = fetches[3].status === "fulfilled" ? fetches[3].value : null;
  sedBytes = fetches[4].status === "fulfilled" ? fetches[4].value : null;
  genCatBytes = fetches[5].status === "fulfilled" ? fetches[5].value : null;

  if (!kernelWasmBytes) {
    throw new Error("Failed to fetch kernel wasm");
  }

  window.__testCount = 0;

  window.__runTest = async (
    wasmBytes: ArrayBuffer,
    argv?: string[],
    timeoutMs = 30_000,
    options?: { dataFiles?: DataFile[]; cwd?: string; env?: string[] },
  ) => {
    let stdout = "";
    let stderr = "";

    // Build a map of VFS path → ArrayBuffer for exec resolution.
    // This avoids reading from VFS (which has write-order issues) and
    // directly maps data file paths to their original binary content.
    const execMap = new Map<string, ArrayBuffer>();
    if (options?.dataFiles) {
      for (const file of options.dataFiles) {
        if (file.useWasmBytes) {
          execMap.set(file.path, wasmBytes);
        }
      }
    }

    const kernel = new BrowserKernel({
      onStdout: (data: Uint8Array) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (data: Uint8Array) => {
        stderr += new TextDecoder().decode(data);
      },
      onExec: async (_pid, path, _argv, _envp) => {
        // Check exec map first (handles self-exec tests)
        if (execMap.has(path)) return execMap.get(path)!;
        // Fall back to known tool binaries
        return resolveToolExec(path);
      },
    });

    try {
      await kernel.init(kernelWasmBytes!);
      populateExecStubs(kernel.fs);

      // Populate VFS with data files if provided
      if (options?.dataFiles) {
        for (const file of options.dataFiles) {
          // Ensure parent directories exist
          const parts = file.path.split("/").filter(Boolean);
          let dirPath = "";
          for (let i = 0; i < parts.length - 1; i++) {
            dirPath += "/" + parts[i];
            try {
              kernel.fs.mkdir(dirPath, 0o755);
            } catch {
              // Directory may already exist
            }
          }
          // Write the file — use wasmBytes if flagged, otherwise use provided data
          const fileData = file.useWasmBytes
            ? new Uint8Array(wasmBytes)
            : new Uint8Array(file.data!);
          const fd = kernel.fs.open(file.path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
          kernel.fs.write(fd, fileData, null, fileData.length);
          kernel.fs.close(fd);
        }
      }

      // Run the test with a timeout
      const cwd = options?.cwd;
      const spawnOpts: { cwd?: string; env?: string[] } = {};
      if (cwd) spawnOpts.cwd = cwd;
      if (options?.env) spawnOpts.env = options.env;
      const exitCode = await Promise.race([
        kernel.spawn(wasmBytes, argv ?? ["test"], spawnOpts),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs),
        ),
      ]);

      return { exitCode, stdout, stderr };
    } finally {
      // Clean up to free memory for the next test
      await kernel.destroy();
      window.__testCount++;
    }
  };

  document.getElementById("status")!.textContent = "Ready";
  window.__testRunnerReady = true;
}

init().catch((err) => {
  document.getElementById("status")!.textContent = `Error: ${err.message}`;
  console.error("Test runner init failed:", err);
});
