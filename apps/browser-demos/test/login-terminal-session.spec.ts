import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  DEMO_AUTOLOGIN_MOTD,
  DEMO_LOGIN_PASSWORD,
  DEMO_LOGIN_PASSWORD_HASH,
  DEMO_SUDOERS,
} from "../../../images/vfs/lib/demo-login";
import { resolveBinary } from "../../../host/src/binary-resolver";

const repoRoot = resolve(import.meta.dirname, "../../..");
const modulePaths = {
  browserKernel: resolve(repoRoot, "host/src/browser-kernel-host.ts"),
  memoryFs: resolve(repoRoot, "host/src/vfs/memory-fs.ts"),
  privilegedProjection: resolve(
    repoRoot,
    "host/src/vfs/privileged-projection.ts",
  ),
  sessionHost: resolve(
    repoRoot,
    "web-libs/kandelo-session/src/kernel-host.ts",
  ),
  terminalPolicy: resolve(
    repoRoot,
    "apps/browser-demos/pages/kandelo/kernel-host/demo-terminal-sessions.ts",
  ),
  demoLoginLoader: resolve(
    repoRoot,
    "apps/browser-demos/pages/kandelo/kernel-host/demo-login-loader.ts",
  ),
};
const shellWasm = resolve(
  repoRoot,
  "local-binaries/programs/wasm32/sh.wasm",
);
const loginWasm = resolve(
  repoRoot,
  "local-binaries/test-fixtures/wasm32/login.wasm",
);
const credentialsWasm = resolve(
  repoRoot,
  "examples/initial-credentials-test.wasm",
);

test("BrowserKernel session supervises one real login lifecycle per logical PTY", async ({
  page,
  baseURL,
}) => {
  test.setTimeout(180_000);
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
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const asViteFsUrl = (path: string) => new URL(`/@fs${path}`, baseURL).href;

  const result = await page.evaluate(
    async ({
      autologinMotd,
      browserKernelUrl,
      credentialsUrl,
      demoLoginLoaderUrl,
      kernelUrl,
      loginUrl,
      memoryFsUrl,
      password,
      passwordHash,
      privilegedProjectionUrl,
      sessionHostUrl,
      shellUrl,
      sudoers,
      terminalPolicyUrl,
    }) => {
      const { BrowserKernel } = await import(
        /* @vite-ignore */ browserKernelUrl
      );
      const { MemoryFileSystem } = await import(
        /* @vite-ignore */ memoryFsUrl
      );
      const {
        createReviewedPrivilegedProgramPolicy,
        publishPrivilegedProgramProduct,
      } = await import(/* @vite-ignore */ privilegedProjectionUrl);
      const { LiveKernelHost } = await import(
        /* @vite-ignore */ sessionHostUrl
      );
      const { DEMO_TERMINAL_SESSION_POLICY } = await import(
        /* @vite-ignore */ terminalPolicyUrl
      );
      const { initializeDemoLoginKernel } = await import(
        /* @vite-ignore */ demoLoginLoaderUrl
      );
      const fetchBytes = async (url: string): Promise<Uint8Array> => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      };
      const [kernelBytes, shell, login, credentials] = await Promise.all([
        fetchBytes(kernelUrl),
        fetchBytes(shellUrl),
        fetchBytes(loginUrl),
        fetchBytes(credentialsUrl),
      ]);
      const loginDigest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", login)),
      ).map((byte) => byte.toString(16).padStart(2, "0")).join("");

      const sourceFs = MemoryFileSystem.create(
        new SharedArrayBuffer(8 * 1024 * 1024),
      );
      const destinations = [
        ["login", "/usr/bin/login"],
        ["sudo-lite", "/usr/bin/sudo-lite"],
        ["sudo", "/usr/bin/sudo"],
      ] as const;
      for (const [sourcePath] of destinations) {
        sourceFs.createFileWithOwner(
          `/${sourcePath}`,
          0o755,
          1000,
          1000,
          login,
        );
      }
      const bottleSha256 = "a".repeat(64);
      const privilegedProduct = await publishPrivilegedProgramProduct({
        policy: createReviewedPrivilegedProgramPolicy(
          destinations.map(([sourcePath, destinationPath]) => ({
            schema: 1,
            formula: `kandelo-test/${sourcePath}`,
            bottleSha256,
            sourcePath,
            destinationPath,
            uid: 0,
            gid: 0,
            mode: 0o4755,
            mountPoint: "trusted-root-product",
            artifactValidationSha256: loginDigest,
          })),
        ),
        sources: destinations.map(([sourcePath]) => ({
          formula: `kandelo-test/${sourcePath}`,
          bottleSha256,
          fs: sourceFs,
          inventory: {
            entries: [{
              sourcePath,
              type: "file" as const,
              size: login.byteLength,
            }],
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
      ]) fs.mkdir(path, 0o755);
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
          "root:*:0:0:99999:7:::\n" +
            `maker:${passwordHash}:0:0:99999:7:::\n`,
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
        "/etc/motd",
        0o644,
        0,
        0,
        enc.encode("Browser ordinary login\n"),
      );
      fs.createFileWithOwner(
        "/etc/motd.autologin",
        0o644,
        0,
        0,
        enc.encode(autologinMotd),
      );
      fs.createFileWithOwner(
        "/etc/sudoers",
        0o440,
        0,
        0,
        enc.encode(sudoers),
      );
      fs.createFileWithOwner("/bin/sh", 0o755, 0, 0, shell);
      fs.createFileWithOwner(
        "/bin/credentials",
        0o755,
        0,
        0,
        credentials,
      );
      // This represents an otherwise ordinary third-party image. Its local
      // set-ID metadata is not authority; the separately published product
      // below must still admit these exact bytes through the private loader.
      fs.createFileWithOwner("/usr/bin/login", 0o4755, 0, 0, login);
      const image = await fs.saveImage();
      const kernelWasm = kernelBytes.buffer.slice(
        kernelBytes.byteOffset,
        kernelBytes.byteOffset + kernelBytes.byteLength,
      );

      const diagnostics: string[] = [];
      const kernel = new BrowserKernel({
        maxWorkers: 4,
        env: ["TERM=xterm-kandelo", "PATH=/usr/local/bin:/usr/bin:/bin"],
        onHostDiagnostic(diagnostic: { message: string }) {
          diagnostics.push(diagnostic.message);
        },
      });
      const spawns: Array<{ path: string; argv: string[]; pid: number }> = [];
      const originalSpawnFromVfs = kernel.spawnFromVfs.bind(kernel);
      kernel.spawnFromVfs = async (
        path: string,
        argv: string[],
        options?: Parameters<typeof originalSpawnFromVfs>[2],
      ) => {
        const spawned = await originalSpawnFromVfs(path, argv, options);
        spawns.push({ path, argv: argv.slice(), pid: spawned.pid });
        return spawned;
      };
      const waitFor = async (
        predicate: () => boolean | Promise<boolean>,
        label: string,
        timeoutMs = 20_000,
      ): Promise<void> => {
        const deadline = performance.now() + timeoutMs;
        while (!(await predicate())) {
          if (performance.now() >= deadline) {
            throw new Error(`timed out waiting for ${label}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      const occurrences = (text: string, needle: string): number =>
        text.split(needle).length - 1;
      const collect = async (
        host: InstanceType<typeof LiveKernelHost>,
        path: string,
      ) => {
        const pty = await host.attachPty(path, { cols: 100, rows: 30 });
        let text = "";
        const off = pty.onData((bytes: Uint8Array) => {
          text += new TextDecoder().decode(bytes);
        });
        return { pty, off, text: () => text };
      };

      try {
        const loginSessionsEnabled = await initializeDemoLoginKernel({
          kernel,
          fs,
          kernelWasm,
          vfsImage: image,
          privilegedProduct,
        });
        if (!loginSessionsEnabled) {
          throw new Error("production loader rejected the reviewed login product");
        }
        const host = new LiveKernelHost({
          kernel,
          status: "running",
        });
        host.setTerminalSessionPolicy(DEMO_TERMINAL_SESSION_POLICY);
        const primary = await collect(host, "/dev/pts/0");
        await waitFor(
          () => primary.text().includes("Every new terminal logs in automatically."),
          "initial autologin message",
        );
        primary.pty.write("/bin/credentials\n");
        await waitFor(
          () => primary.text().includes("uid=1000 euid=1000 gid=1000 egid=1000"),
          "maker credentials",
        );

        const spawnCountBeforeReattach = spawns.length;
        primary.off();
        primary.pty.close();
        const reattached = await collect(host, "/dev/pts/0");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const spawnCountAfterReattach = spawns.length;
        const autologinBeforeLogout = occurrences(
          reattached.text(),
          "Every new terminal logs in automatically.",
        );

        const loginPromptsBeforeLogout = occurrences(
          reattached.text(),
          "login: ",
        );
        reattached.pty.write("exit\n");
        await waitFor(() => spawns.length >= 2, "ordinary login restart");
        await waitFor(
          () => occurrences(reattached.text(), "login: ") > loginPromptsBeforeLogout,
          "login prompt",
        );
        reattached.pty.write("maker\n");
        await waitFor(
          () => reattached.text().includes("Password: "),
          "password prompt",
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        const loginPromptsBeforeFailure = occurrences(
          reattached.text(),
          "login: ",
        );
        reattached.pty.write("definitely-wrong\n");
        await waitFor(
          () => reattached.text().includes("Login incorrect"),
          "failed password",
        );
        await waitFor(() => spawns.length >= 3, "login after rejection");

        await waitFor(
          () => occurrences(reattached.text(), "login: ") > loginPromptsBeforeFailure,
          "login prompt after rejection",
        );
        const passwordPrompts = occurrences(reattached.text(), "Password: ");
        reattached.pty.write("maker\n");
        await waitFor(
          () => occurrences(reattached.text(), "Password: ") > passwordPrompts,
          "second password prompt",
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        reattached.pty.write(`${password}\n`);
        const credentialsBefore = occurrences(reattached.text(), "uid=1000");
        const ordinaryMotdsBefore = occurrences(
          reattached.text(),
          "Browser ordinary login",
        );
        await waitFor(
          () => occurrences(
            reattached.text(),
            "Browser ordinary login",
          ) > ordinaryMotdsBefore,
          "successful ordinary login",
        );
        reattached.pty.write("/bin/credentials\n");
        await waitFor(
          () => occurrences(reattached.text(), "uid=1000") > credentialsBefore,
          "post-password maker credentials",
        );

        const secondary = await collect(host, "/dev/pts/1");
        await waitFor(
          () => secondary.text().includes("Every new terminal logs in automatically."),
          "secondary autologin",
        );
        const secondaryPid = spawns.at(-1)?.pid;
        if (secondaryPid === undefined) {
          throw new Error("secondary login spawn did not report a pid");
        }
        const secondarySpawnCount = spawns.length;
        secondary.pty.close();
        const secondaryReattach = await collect(host, "/dev/pts/1");
        await new Promise((resolve) => setTimeout(resolve, 100));
        const secondarySpawnCountAfterReattach = spawns.length;

        host.removePty("/dev/pts/1");
        await waitFor(
          async () => !(await kernel.enumProcs()).some(
            (proc: { pid: number }) => proc.pid === secondaryPid,
          ),
          "removed secondary process",
        );
        const replacement = await collect(host, "/dev/pts/1");
        await waitFor(
          () => replacement.text().includes("Every new terminal logs in automatically."),
          "replacement logical PTY autologin",
        );

        const beforeDetach = spawns.length;
        host.detachKernel();
        await new Promise((resolve) => setTimeout(resolve, 5_250));
        return {
          argv: spawns.map(({ argv }) => argv),
          autologinAfterPassword: occurrences(
            reattached.text(),
            "Every new terminal logs in automatically.",
          ),
          autologinBeforeLogout,
          beforeDetach,
          diagnostics,
          failedPasswordEchoed: reattached.text().includes("definitely-wrong"),
          programPaths: spawns.map(({ path }) => path),
          spawnCountAfterReattach,
          spawnCountBeforeReattach,
          spawnCountAfterDetachDelay: spawns.length,
          secondarySpawnCount,
          secondarySpawnCountAfterReattach,
          loginSessionsEnabled,
        };
      } finally {
        await kernel.destroy().catch(() => {});
      }
    },
    {
      autologinMotd: DEMO_AUTOLOGIN_MOTD,
      browserKernelUrl: asViteFsUrl(modulePaths.browserKernel),
      credentialsUrl: asViteFsUrl(credentialsWasm),
      demoLoginLoaderUrl: asViteFsUrl(modulePaths.demoLoginLoader),
      kernelUrl: asViteFsUrl(resolveBinary("kernel.wasm")),
      loginUrl: asViteFsUrl(loginWasm),
      memoryFsUrl: asViteFsUrl(modulePaths.memoryFs),
      password: DEMO_LOGIN_PASSWORD,
      passwordHash: DEMO_LOGIN_PASSWORD_HASH,
      privilegedProjectionUrl: asViteFsUrl(modulePaths.privilegedProjection),
      sessionHostUrl: asViteFsUrl(modulePaths.sessionHost),
      shellUrl: asViteFsUrl(shellWasm),
      sudoers: DEMO_SUDOERS,
      terminalPolicyUrl: asViteFsUrl(modulePaths.terminalPolicy),
    },
  );

  expect(result.argv[0]).toEqual(["login", "-p", "-f", "maker"]);
  expect(result.loginSessionsEnabled).toBe(true);
  expect(result.argv[1]).toEqual(["login", "-p"]);
  expect(result.argv[2]).toEqual(["login", "-p"]);
  expect(result.programPaths.every((path) => path === "/usr/bin/login"))
    .toBe(true);
  expect(result.spawnCountAfterReattach).toBe(result.spawnCountBeforeReattach);
  expect(result.autologinAfterPassword).toBe(result.autologinBeforeLogout);
  expect(result.failedPasswordEchoed).toBe(false);
  expect(result.secondarySpawnCountAfterReattach).toBe(
    result.secondarySpawnCount,
  );
  expect(result.spawnCountAfterDetachDelay).toBe(result.beforeDetach);
  expect(result.diagnostics).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});
