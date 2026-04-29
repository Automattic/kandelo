/**
 * Browser test page for git HTTP clone.
 *
 * Loads git.wasm and git-remote-http.wasm, writes them to the VFS,
 * and exposes window.__runGitClone(url) for Playwright to call.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import kernelWasmUrl from "@kernel-wasm?url";
import gitWasmUrl from "../../../../binaries/programs/wasm32/git/git.wasm?url";
import gitRemoteHttpWasmUrl from "../../../../binaries/programs/wasm32/git/git-remote-http.wasm?url";

declare global {
  interface Window {
    __gitTestReady: boolean;
    __runGitClone: (httpUrl: string) => Promise<{
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
  }
}

let kernelWasmBytes: ArrayBuffer | null = null;
let gitBytes: ArrayBuffer | null = null;
let gitRemoteHttpBytes: ArrayBuffer | null = null;

/** Write a binary file to the virtual filesystem. */
function writeFileToFs(
  fs: BrowserKernel["fs"],
  path: string,
  data: ArrayBuffer,
): void {
  const bytes = new Uint8Array(data);
  const fd = fs.open(path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
  fs.write(fd, bytes, null, bytes.length);
  fs.close(fd);
}

async function init() {
  const fetches = await Promise.allSettled([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(gitWasmUrl).then((r) => r.arrayBuffer()),
    fetch(gitRemoteHttpWasmUrl).then((r) => r.arrayBuffer()),
  ]);

  kernelWasmBytes =
    fetches[0].status === "fulfilled" ? fetches[0].value : null;
  gitBytes = fetches[1].status === "fulfilled" ? fetches[1].value : null;
  gitRemoteHttpBytes =
    fetches[2].status === "fulfilled" ? fetches[2].value : null;

  if (!kernelWasmBytes) throw new Error("Failed to fetch kernel wasm");
  if (!gitBytes) throw new Error("Failed to fetch git.wasm");
  if (!gitRemoteHttpBytes)
    throw new Error("Failed to fetch git-remote-http.wasm");

  window.__runGitClone = async (httpUrl: string) => {
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

      // Write git binaries to VFS at paths git will exec
      const gitExecPath = "/usr/libexec/git-core";
      for (const dir of [
        "/usr",
        "/usr/libexec",
        "/usr/libexec/git-core",
        "/usr/bin",
      ]) {
        try {
          kernel.fs.mkdir(dir, 0o755);
        } catch {
          /* exists */
        }
      }

      writeFileToFs(kernel.fs, `${gitExecPath}/git`, gitBytes!);
      writeFileToFs(
        kernel.fs,
        `${gitExecPath}/git-remote-http`,
        gitRemoteHttpBytes!,
      );
      // Also write to /usr/bin for PATH-based resolution
      writeFileToFs(kernel.fs, "/usr/bin/git", gitBytes!);
      writeFileToFs(
        kernel.fs,
        "/usr/bin/git-remote-http",
        gitRemoteHttpBytes!,
      );

      const cloneDir = "/tmp/git-clone";
      const env = [
        "GIT_CONFIG_NOSYSTEM=1",
        "GIT_CONFIG_COUNT=4",
        "GIT_CONFIG_KEY_0=gc.auto",
        "GIT_CONFIG_VALUE_0=0",
        "GIT_CONFIG_KEY_1=user.name",
        "GIT_CONFIG_VALUE_1=Test",
        "GIT_CONFIG_KEY_2=user.email",
        "GIT_CONFIG_VALUE_2=test@wasm.local",
        "GIT_CONFIG_KEY_3=init.defaultBranch",
        "GIT_CONFIG_VALUE_3=main",
        `GIT_EXEC_PATH=${gitExecPath}`,
        "HOME=/home",
        "TMPDIR=/tmp",
      ];

      const exitCode = await Promise.race([
        kernel.spawn(gitBytes!, ["git", "clone", httpUrl, cloneDir], { env }),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("TIMEOUT")), 120_000),
        ),
      ]);

      return { exitCode, stdout, stderr };
    } finally {
      await kernel.destroy();
    }
  };

  document.getElementById("status")!.textContent = "Ready";
  window.__gitTestReady = true;
}

init().catch((err) => {
  document.getElementById("status")!.textContent = `Error: ${err.message}`;
  console.error("Git test init failed:", err);
});
