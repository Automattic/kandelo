#!/usr/bin/env tsx
import { createServer, type IncomingMessage } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { findRepoRoot } from "../host/src/binary-resolver";

const REPO_ROOT = findRepoRoot();
const BROWSER_DIR = join(REPO_ROOT, "apps/browser-demos");
const VFS_IMAGE = join(BROWSER_DIR, "public/spidermonkey-test.vfs.zst");
const VITE_HOST = "127.0.0.1";
const VITE_PORT = Number(process.env.SPIDERMONKEY_TEST_VITE_PORT ?? 5202);
const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_PORT ?? 5312);

interface RunRequest {
  argv: string[];
  timeoutMs?: number;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
  processReaped?: boolean;
  bridgeRetries?: number;
}

function readPageEvaluateRetries(): number {
  const value = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_PAGE_RETRIES ?? 2);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
}

const PAGE_EVALUATE_RETRIES = readPageEvaluateRetries();

function isPageContextLoss(message: string): boolean {
  return /Target page|Execution context|closed|detached|navigation/i.test(message);
}

async function waitForProcess(proc: ChildProcess, description: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    proc.on("exit", (code) => {
      code === 0 ? resolve() : reject(new Error(`${description} exited ${code}`));
    });
    proc.on("error", reject);
  });
}

async function startViteServer(): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "npx",
      [
        "vite",
        "--config", join(BROWSER_DIR, "vite.config.ts"),
        "--host", VITE_HOST,
        "--port", String(VITE_PORT),
        "--strictPort",
      ],
      {
        cwd: BROWSER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, KANDELO_BROWSER_DEMO_INPUTS: "spidermonkey-test" },
      },
    );
    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error("Vite server did not start within 30s"));
      }
    }, 30_000);
    proc.stdout!.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stderr.write(`[vite] ${text}`);
      if (!started && text.includes("Local:")) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolvePromise(proc), 500);
      }
    });
    proc.stderr!.on("data", (data: Buffer) => {
      process.stderr.write(`[vite] ${data}`);
    });
    proc.on("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Vite exited with code ${code}`));
      }
    });
  });
}

async function openPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      console.error(`[browser:${msg.type()}] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    console.error(`[browser:pageerror] ${err.stack || err.message}`);
  });
  page.on("crash", () => {
    console.error("[browser:crash] page crashed");
  });
  await page.goto(`http://${VITE_HOST}:${VITE_PORT}/pages/spidermonkey-test/`);
  await page.waitForFunction(
    () => (window as any).__spiderMonkeyTestReady === true,
    {},
    { timeout: 180_000 },
  );
  return page;
}

function readJsonBody(req: IncomingMessage): Promise<RunRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function main() {
  if (!existsSync(VFS_IMAGE) || process.env.SPIDERMONKEY_OFFICIAL_REBUILD_VFS === "1") {
    const proc = spawn(
      "bash",
      [join(REPO_ROOT, "images/vfs/scripts/build-spidermonkey-test-vfs-image.sh")],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env },
      },
    );
    await waitForProcess(proc, "SpiderMonkey test VFS build");
  }

  const vite = await startViteServer();
  const browser = await chromium.launch({
    args: ["--enable-features=SharedArrayBuffer"],
  });
  let page = await openPage(browser);
  let queue = Promise.resolve();

  async function reopenPage(reason: string): Promise<void> {
    console.error(`[browser js shell bridge] reopening page after ${reason}`);
    await page.context().close().catch(() => {});
    page = await openPage(browser);
  }

  async function runInPage(body: RunRequest): Promise<RunResult> {
    let retries = 0;
    for (;;) {
      try {
        const result = await page.evaluate(
          (request) => (window as any).__runSpiderMonkeyScript(request),
          { argv: body.argv, timeoutMs: body.timeoutMs },
        ) as RunResult;
        if (retries > 0) result.bridgeRetries = retries;
        return result;
      } catch (err: any) {
        const message = err?.message || String(err);
        if (!isPageContextLoss(message) || retries >= PAGE_EVALUATE_RETRIES) {
          throw err;
        }
        retries++;
        await reopenPage(
          `Playwright context loss (${retries}/${PAGE_EVALUATE_RETRIES}): ${message}`,
        );
      }
    }
  }

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/run") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    queue = queue.then(async () => {
      try {
        const body = await readJsonBody(req);
        const result = await runInPage(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        const message = err?.message || String(err);
        if (isPageContextLoss(message)) {
          await reopenPage(`unrecovered Playwright error: ${message}`).catch(() => {});
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          exitCode: -1,
          stdout: "",
          stderr: "",
          error: message,
          durationMs: 0,
        }));
      }
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(SERVER_PORT, SERVER_HOST, resolveListen);
  });
  console.error(`browser js shell bridge listening on http://${SERVER_HOST}:${SERVER_PORT}/run`);

  const shutdown = async () => {
    server.close();
    await browser.close().catch(() => {});
    vite.kill();
  };
  process.on("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.on("SIGINT", () => { void shutdown().finally(() => process.exit(130)); });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
