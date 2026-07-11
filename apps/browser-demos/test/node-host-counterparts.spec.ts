import { expect, test } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { tryResolveBinary } from "../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../../..");
const publicDir = join(repoRoot, "apps", "browser-demos", "public");

interface ServiceImageRef {
  relPath: string;
  publicFile: string;
  buildHint: string;
}

interface RunningDemo {
  proc: ChildProcess;
  output: () => string;
}

const serviceImages = {
  nginx: {
    relPath: "programs/nginx-vfs.vfs.zst",
    publicFile: "nginx.vfs.zst",
    buildHint: "./run.sh build nginx-vfs",
  },
  nginxPhp: {
    relPath: "programs/nginx-php-vfs.vfs.zst",
    publicFile: "nginx-php.vfs.zst",
    buildHint: "./run.sh build nginx-php-vfs",
  },
  wordpress: {
    relPath: "programs/wordpress.vfs.zst",
    publicFile: "wordpress.vfs.zst",
    buildHint: "./run.sh build wp-vfs",
  },
  lamp: {
    relPath: "programs/lamp.vfs.zst",
    publicFile: "lamp.vfs.zst",
    buildHint: "./run.sh build lamp-vfs",
  },
} satisfies Record<string, ServiceImageRef>;

function hasServiceImage(image: ServiceImageRef): boolean {
  return !!tryResolveBinary(image.relPath) || existsSync(join(publicDir, image.publicFile));
}

function skipUnlessRunnable(label: string, image: ServiceImageRef): void {
  test.skip(!tryResolveBinary("kernel.wasm"), `${label}: kernel.wasm is not built`);
  test.skip(
    !hasServiceImage(image),
    `${label}: service VFS image is not built (${image.buildHint})`,
  );
}

function skipUnlessProgram(label: string, relPath: string): void {
  test.skip(!tryResolveBinary("kernel.wasm"), `${label}: kernel.wasm is not built`);
  test.skip(!tryResolveBinary(relPath), `${label}: ${relPath} is not built`);
}

async function getFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function isPortAvailable(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

async function startNodeHostDemo(
  script: string,
  args: string[],
  readyPattern: RegExp,
  timeoutMs: number,
): Promise<RunningDemo> {
  const proc = spawn("npx", ["tsx", script, ...args], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let settled = false;

  const append = (chunk: Buffer) => {
    output += chunk.toString();
  };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${script}.\n${output.slice(-4000)}`));
      }, timeoutMs);

      const check = () => {
        if (readyPattern.test(output)) {
          clearTimeout(timeout);
          settled = true;
          resolve();
        }
      };

      proc.stdout?.on("data", check);
      proc.stderr?.on("data", check);
      proc.once("exit", (code, signal) => {
        clearTimeout(timeout);
        if (!settled) {
          reject(
            new Error(
              `${script} exited before readiness (code=${code}, signal=${signal}).\n` +
                output.slice(-4000),
            ),
          );
        }
      });
    });
  } catch (e) {
    await stopNodeHostDemo(proc);
    throw e;
  }

  return { proc, output: () => output };
}

async function stopNodeHostDemo(proc: ChildProcess): Promise<void> {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;

  const waitForExit = new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
  });

  signalProcess(proc, "SIGTERM");
  const exited = await Promise.race([
    waitForExit.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);

  if (!exited) {
    signalProcess(proc, "SIGKILL");
    await waitForExit.catch(() => {});
  }
}

function signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (!proc.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    try {
      proc.kill(signal);
    } catch {
      // Already exited.
    }
  }
}

async function fetchText(url: string, timeoutMs = 30_000): Promise<string> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text();
  expect(resp.status, text.slice(0, 1000)).toBeLessThan(500);
  return text;
}

test.describe.configure({ mode: "serial" });

test.describe("Node-host counterparts for Kandelo browser demos", () => {
  test("shell command runner executes dash like the browser shell demo", () => {
    test.setTimeout(60_000);
    skipUnlessProgram("shell Node-host demo", "programs/dash.wasm");

    const output = execFileSync(
      "npx",
      [
        "tsx",
        "packages/registry/shell/demo/serve.ts",
        "-c",
        "echo KANDELO_NODE_HOST_SHELL_OK",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 45_000,
      },
    );

    expect(output).toContain("KANDELO_NODE_HOST_SHELL_OK");
  });

  test("nginx serves the same static page as the browser nginx demo", async () => {
    test.setTimeout(180_000);
    skipUnlessRunnable("nginx Node-host demo", serviceImages.nginx);

    const port = await getFreePort();
    const demo = await startNodeHostDemo(
      "packages/registry/nginx/demo/serve.ts",
      [String(port)],
      /nginx running under dinit/i,
      120_000,
    );

    try {
      const html = await fetchText(`http://127.0.0.1:${port}/`);
      expect(html).toContain("Hello from nginx on WebAssembly!");
      expect(html).toContain("/sbin/dinit");
    } finally {
      await stopNodeHostDemo(demo.proc);
    }
  });

  test("nginx + PHP serves dynamic PHP like the browser nginx + PHP demo", async () => {
    test.setTimeout(240_000);
    skipUnlessRunnable("nginx + PHP Node-host demo", serviceImages.nginxPhp);

    const port = await getFreePort();
    const demo = await startNodeHostDemo(
      "packages/registry/nginx/demo/serve-php.ts",
      [String(port)],
      /nginx \+ PHP-FPM running under dinit/i,
      180_000,
    );

    try {
      const html = await fetchText(`http://127.0.0.1:${port}/info.php`);
      expect(html).toContain("PHP-FPM on WebAssembly");
      expect(html).toMatch(/REQUEST_URI|SERVER_SOFTWARE|PHP/);
    } finally {
      await stopNodeHostDemo(demo.proc);
    }
  });

  test("WordPress SQLite reaches the installer like the browser WordPress SQLite demo", async () => {
    test.setTimeout(300_000);
    skipUnlessRunnable("WordPress SQLite Node-host demo", serviceImages.wordpress);

    const port = await getFreePort();
    const demo = await startNodeHostDemo(
      "packages/registry/wordpress/demo/serve.ts",
      [String(port)],
      /WordPress running behind nginx \+ php-fpm/i,
      180_000,
    );

    try {
      const html = await fetchText(`http://127.0.0.1:${port}/`);
      expect(html).toMatch(/WordPress|wp-admin|install/i);
    } finally {
      await stopNodeHostDemo(demo.proc);
    }
  });

  test("WordPress MariaDB reaches the installer like the browser WordPress MariaDB demo", async () => {
    test.setTimeout(420_000);
    skipUnlessRunnable("WordPress MariaDB Node-host demo", serviceImages.lamp);
    test.skip(
      !(await isPortAvailable(3306)),
      "WordPress MariaDB Node-host demo needs host port 3306",
    );

    const port = await getFreePort();
    const demo = await startNodeHostDemo(
      "packages/registry/lamp/demo/serve.ts",
      [String(port)],
      /LAMP stack running under dinit/i,
      300_000,
    );

    try {
      const html = await fetchText(`http://127.0.0.1:${port}/`);
      expect(html).toMatch(/WordPress|wp-admin|install/i);
    } finally {
      await stopNodeHostDemo(demo.proc);
    }
  });
});
