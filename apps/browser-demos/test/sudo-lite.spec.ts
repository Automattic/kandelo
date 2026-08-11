import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  DEMO_LOGIN_PASSWORD,
  DEMO_LOGIN_PASSWORD_HASH,
} from "../../../images/vfs/lib/demo-login";
import { resolveBinary } from "../../../host/src/binary-resolver";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const browserKernelModulePath = resolve(
  repoRoot,
  "host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(repoRoot, "host/src/vfs/memory-fs.ts");
const privilegedProjectionModulePath = resolve(
  repoRoot,
  "host/src/vfs/privileged-projection.ts",
);
const shellWasm = resolve(repoRoot, "local-binaries/programs/wasm32/sh.wasm");
const loginWasm = resolve(
  repoRoot,
  "local-binaries/test-fixtures/wasm32/login.wasm",
);
const sudoWasm = resolve(
  repoRoot,
  "local-binaries/test-fixtures/wasm32/sudo-lite.wasm",
);
const credentialsWasm = resolve(
  repoRoot,
  "examples/initial-credentials-test.wasm",
);
const execArgvSource = resolve(repoRoot, "host/test/fixtures/exec-argv.c");
const fixtureDir = mkdtempSync(join(tmpdir(), "kandelo-browser-sudo-lite-"));
const execArgvWasm = join(fixtureDir, "exec-argv.wasm");

test.beforeAll(() => {
  execFileSync("wasm32posix-cc", [execArgvSource, "-o", execArgvWasm], {
    cwd: repoRoot,
    stdio: "pipe",
  });
});

test.afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

test("browser login and sudo-lite enforce real guest authentication", async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      runtimeErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }));
  const asViteFsUrl = (path: string) => new URL(`/@fs${path}`, baseURL).href;
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(
    async ({
      browserKernelModuleUrl,
      memoryFsModuleUrl,
      privilegedProjectionModuleUrl,
      kernelWasmUrl,
      shellWasmUrl,
      loginWasmUrl,
      sudoWasmUrl,
      credentialsWasmUrl,
      execArgvBytes,
      password,
      passwordHash,
    }) => {
      const { BrowserKernel } = await import(
        /* @vite-ignore */ browserKernelModuleUrl
      );
      const { MemoryFileSystem } = await import(
        /* @vite-ignore */ memoryFsModuleUrl
      );
      const {
        createReviewedPrivilegedProgramPolicy,
        publishPrivilegedProgramProduct,
      } = await import(/* @vite-ignore */ privilegedProjectionModuleUrl);
      const fetchBytes = async (url: string): Promise<Uint8Array> => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      };
      const [kernelBytes, shell, login, sudo, credentials] = await Promise.all([
        fetchBytes(kernelWasmUrl),
        fetchBytes(shellWasmUrl),
        fetchBytes(loginWasmUrl),
        fetchBytes(sudoWasmUrl),
        fetchBytes(credentialsWasmUrl),
      ]);
      const sha256 = async (bytes: Uint8Array): Promise<string> =>
        Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      const [loginDigest, sudoDigest] = await Promise.all([
        sha256(login),
        sha256(sudo),
      ]);

      // Test fixture bytes use the same closed publication API as bottles.
      // No fixture is installed in a product resolver or Homebrew path.
      const sourceFs = MemoryFileSystem.create(
        new SharedArrayBuffer(16 * 1024 * 1024),
      );
      sourceFs.createFileWithOwner("/login", 0o755, 1000, 1000, login);
      sourceFs.createFileWithOwner("/sudo-lite", 0o755, 1000, 1000, sudo);
      sourceFs.createFileWithOwner("/sudo", 0o755, 1000, 1000, sudo);
      const sourceRecords = [
        {
          formula: "kandelo-test/login",
          bottleSha256: "a".repeat(64),
          sourcePath: "login",
          destinationPath: "/usr/bin/login",
          digest: loginDigest,
          size: login.byteLength,
        },
        {
          formula: "kandelo-test/sudo-lite",
          bottleSha256: "b".repeat(64),
          sourcePath: "sudo-lite",
          destinationPath: "/usr/bin/sudo-lite",
          digest: sudoDigest,
          size: sudo.byteLength,
        },
        {
          formula: "kandelo-test/sudo",
          bottleSha256: "c".repeat(64),
          sourcePath: "sudo",
          destinationPath: "/usr/bin/sudo",
          digest: sudoDigest,
          size: sudo.byteLength,
        },
      ];
      const policy = createReviewedPrivilegedProgramPolicy(
        sourceRecords.map((record) => ({
          schema: 1,
          formula: record.formula,
          bottleSha256: record.bottleSha256,
          sourcePath: record.sourcePath,
          destinationPath: record.destinationPath,
          uid: 0,
          gid: 0,
          mode: 0o4755,
          mountPoint: "trusted-root-product",
          artifactValidationSha256: record.digest,
        })),
      );
      const privilegedProduct = await publishPrivilegedProgramProduct({
        policy,
        sources: sourceRecords.map((record) => ({
          formula: record.formula,
          bottleSha256: record.bottleSha256,
          fs: sourceFs,
          inventory: {
            entries: [
              {
                sourcePath: record.sourcePath,
                type: "file" as const,
                size: record.size,
              },
            ],
          },
          guestPathForSource: (path: string) => `/${path}`,
        })),
        writableBottleFileSystems: [sourceFs],
      });

      const fs = MemoryFileSystem.create(
        new SharedArrayBuffer(16 * 1024 * 1024),
      );
      for (const path of [
        "/etc",
        "/bin",
        "/home",
        "/root",
        "/usr",
        "/usr/bin",
        "/var",
      ]) {
        fs.mkdir(path, 0o755);
      }
      fs.mkdirWithOwner("/home/maker", 0o755, 1000, 1000);
      fs.chmod("/root", 0o700);
      const enc = new TextEncoder();
      fs.createFileWithOwner(
        "/etc/passwd",
        0o644,
        0,
        0,
        enc.encode(
          "root:x:0:0:root:/root:/bin/sh\n" +
            "maker:x:1000:1000:maker:/home/maker:/bin/sh\n",
        ),
      );
      fs.createFileWithOwner(
        "/etc/shadow",
        0o640,
        0,
        0,
        enc.encode(
          "root:*:0:0:99999:7:::\n" + `maker:${passwordHash}:0:0:99999:7:::\n`,
        ),
      );
      fs.createFileWithOwner(
        "/etc/group",
        0o644,
        0,
        0,
        enc.encode("root:x:0:\nwheel:x:10:maker\nmaker:x:1000:\n"),
      );
      fs.createFileWithOwner(
        "/etc/nsswitch.conf",
        0o644,
        0,
        0,
        enc.encode("passwd: files\ngroup: files\nshadow: files\n"),
      );
      fs.createFileWithOwner(
        "/etc/sudoers",
        0o440,
        0,
        0,
        enc.encode("%wheel ALL=(ALL:ALL) ALL\n"),
      );
      fs.createFileWithOwner(
        "/etc/motd",
        0o644,
        0,
        0,
        enc.encode("Browser login\n"),
      );
      fs.createFileWithOwner(
        "/etc/motd.autologin",
        0o644,
        0,
        0,
        enc.encode("Browser preauthentication\n"),
      );
      fs.createFileWithOwner("/bin/sh", 0o755, 0, 0, shell);
      fs.createFileWithOwner(
        "/bin/initial-credentials",
        0o755,
        0,
        0,
        credentials,
      );
      const image = await fs.saveImage();
      const kernelWasm = kernelBytes.buffer.slice(
        kernelBytes.byteOffset,
        kernelBytes.byteOffset + kernelBytes.byteLength,
      );
      const launcher = new Uint8Array(execArgvBytes);

      const run = async (passwordAttempt: string) => {
        let stdout = "";
        let stderr = "";
        let terminal = "";
        const hostDiagnostics: unknown[] = [];
        const stdoutDecoder = new TextDecoder();
        const stderrDecoder = new TextDecoder();
        const terminalDecoder = new TextDecoder();
        const kernel = new BrowserKernel({
          maxWorkers: 4,
          onStdout(data: Uint8Array) {
            stdout += stdoutDecoder.decode(data, { stream: true });
          },
          onStderr(data: Uint8Array) {
            stderr += stderrDecoder.decode(data, { stream: true });
          },
          onHostDiagnostic(diagnostic: unknown) {
            hostDiagnostics.push(diagnostic);
          },
        });
        try {
          await kernel.initFromPublishedPrivilegedProgramProduct({
            kernelWasm,
            vfsImage: image,
            privilegedProduct,
          });
          const exitCode = await Promise.race([
            kernel.spawn(
              launcher.slice().buffer,
              ["exec-argv", "/usr/bin/login", "-f", "maker"],
              {
                uid: 0,
                gid: 0,
                pty: true,
                env: ["TERM=xterm-kandelo", "KANDELO_UNTRUSTED=remove-me"],
                onStarted(pid: number) {
                  let sentPassword = false;
                  let sentExit = false;
                  kernel.onPtyOutput(pid, (data: Uint8Array) => {
                    terminal += terminalDecoder.decode(data, { stream: true });
                    if (
                      !sentPassword &&
                      terminal.includes("[sudo-lite] password for maker: ")
                    ) {
                      sentPassword = true;
                      // sudo changes the terminal with TCSAFLUSH after writing
                      // its prompt. Model a human response after that flush,
                      // rather than racing pending input into the flush.
                      setTimeout(() => {
                        kernel.ptyWrite(
                          pid,
                          enc.encode(`${passwordAttempt}\n`),
                        );
                      }, 100);
                    }
                    if (
                      !sentExit &&
                      (terminal.includes("uid=0 euid=0 gid=0 egid=0") ||
                        terminal.includes("sudo-lite: authentication failed"))
                    ) {
                      sentExit = true;
                      kernel.ptyWrite(pid, enc.encode("exit\n"));
                    }
                  });
                  kernel.ptyWrite(
                    pid,
                    enc.encode("/usr/bin/sudo-lite /bin/initial-credentials\n"),
                  );
                },
              },
            ),
            new Promise<number>((resolve) => {
              setTimeout(() => resolve(-999), 15_000);
            }),
          ]);
          stdout += stdoutDecoder.decode();
          stderr += stderrDecoder.decode();
          terminal += terminalDecoder.decode();
          return { exitCode, stdout, stderr, terminal, hostDiagnostics };
        } finally {
          await kernel.destroy().catch(() => {});
        }
      };

      return {
        accepted: await run(password),
        denied: await run("wrong"),
      };
    },
    {
      browserKernelModuleUrl: asViteFsUrl(browserKernelModulePath),
      memoryFsModuleUrl: asViteFsUrl(memoryFsModulePath),
      privilegedProjectionModuleUrl: asViteFsUrl(
        privilegedProjectionModulePath,
      ),
      kernelWasmUrl: asViteFsUrl(resolveBinary("kernel.wasm")),
      shellWasmUrl: asViteFsUrl(shellWasm),
      loginWasmUrl: asViteFsUrl(loginWasm),
      sudoWasmUrl: asViteFsUrl(sudoWasm),
      credentialsWasmUrl: asViteFsUrl(credentialsWasm),
      execArgvBytes: Array.from(readFileSync(execArgvWasm)),
      password: DEMO_LOGIN_PASSWORD,
      passwordHash: DEMO_LOGIN_PASSWORD_HASH,
    },
  );

  expect(result.accepted.exitCode, result.accepted.terminal).toBe(0);
  expect(result.accepted.terminal).toContain("Browser login\r\n");
  expect(result.accepted.terminal).toContain("Browser preauthentication\r\n");
  expect(result.accepted.terminal).toContain(
    "[sudo-lite] password for maker: ",
  );
  expect(result.accepted.terminal).toContain("uid=0 euid=0 gid=0 egid=0");
  expect(result.accepted.terminal).not.toContain("remove-me");
  expect(result.accepted.hostDiagnostics).toEqual([]);

  expect(result.denied.exitCode).toBe(1);
  expect(result.denied.terminal).toContain("sudo-lite: authentication failed");
  expect(result.denied.terminal).not.toContain("uid=0 euid=0 gid=0 egid=0");
  expect(result.denied.hostDiagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
