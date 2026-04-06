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

/** Write a binary file to the virtual filesystem. */
function writeFileToFs(fs: import("../../lib/browser-kernel").BrowserKernel["fs"], path: string, data: ArrayBuffer): void {
  const bytes = new Uint8Array(data);
  const fd = fs.open(path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
  fs.write(fd, bytes, null, bytes.length);
  fs.close(fd);
}

/** Populate VFS with actual executable binaries and symlinks for exec. */
function populateExecBinaries(fs: import("../../lib/browser-kernel").BrowserKernel["fs"]): void {
  for (const dir of ["/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin"]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }

  if (dashBytes) {
    writeFileToFs(fs, "/bin/dash", dashBytes);
    try { fs.symlink("/bin/dash", "/bin/sh"); } catch { /* exists */ }
    try { fs.symlink("/bin/dash", "/usr/bin/dash"); } catch { /* exists */ }
    try { fs.symlink("/bin/dash", "/usr/bin/sh"); } catch { /* exists */ }
  }

  if (coreutilsBytes) {
    writeFileToFs(fs, "/bin/coreutils", coreutilsBytes);
    for (const name of COREUTILS_NAMES) {
      try { fs.symlink("/bin/coreutils", `/bin/${name}`); } catch { /* exists */ }
      try { fs.symlink("/bin/coreutils", `/usr/bin/${name}`); } catch { /* exists */ }
    }
    try { fs.symlink("/bin/coreutils", "/bin/["); } catch { /* exists */ }
    try { fs.symlink("/bin/coreutils", "/usr/bin/["); } catch { /* exists */ }
  }

  if (grepBytes) {
    writeFileToFs(fs, "/bin/grep", grepBytes);
    try { fs.symlink("/bin/grep", "/bin/egrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/bin/fgrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/grep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/egrep"); } catch { /* exists */ }
    try { fs.symlink("/bin/grep", "/usr/bin/fgrep"); } catch { /* exists */ }
  }

  if (sedBytes) {
    writeFileToFs(fs, "/bin/sed", sedBytes);
    try { fs.symlink("/bin/sed", "/usr/bin/sed"); } catch { /* exists */ }
  }

  if (genCatBytes) {
    writeFileToFs(fs, "/bin/gencat", genCatBytes);
    try { fs.symlink("/bin/gencat", "/usr/bin/gencat"); } catch { /* exists */ }
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

    const kernel = new BrowserKernel({
      onStdout: (data: Uint8Array) => {
        stdout += new TextDecoder().decode(data);
      },
      onStderr: (data: Uint8Array) => {
        stderr += new TextDecoder().decode(data);
      },
    });

    try {
      await kernel.init(kernelWasmBytes!);
      populateExecBinaries(kernel.fs);

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
