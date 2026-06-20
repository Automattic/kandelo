#!/usr/bin/env tsx
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { findRepoRoot } from "../host/src/binary-resolver";

const REPO_ROOT = findRepoRoot();
const BROWSER_DIR = join(REPO_ROOT, "apps/browser-demos");
const VITE_CLI = join(BROWSER_DIR, "node_modules/vite/bin/vite.js");
const VFS_IMAGE = join(BROWSER_DIR, "public/spidermonkey-test.vfs.zst");
const VITE_HOST = "127.0.0.1";
const VITE_PORT = Number(process.env.SPIDERMONKEY_TEST_VITE_PORT ?? 5202);
const SERVER_HOST = "127.0.0.1";
const SERVER_PORT = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_PORT ?? 5312);
const DEFAULT_TIMEOUT_MS = Number(process.env.SPIDERMONKEY_WRAPPER_TIMEOUT_MS ?? 600_000);
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_SHUTDOWN_TIMEOUT_MS ?? 10_000);
const ABANDONED_REQUEST_CLOSE_TIMEOUT_MS = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_ABANDONED_CLOSE_TIMEOUT_MS ?? 1_000);

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
  guestTimeoutRetries?: number;
  memoryPressureRetries?: number;
  wasmOobRetries?: number;
}

class ClientAbortError extends Error {
  constructor() {
    super("client disconnected");
    this.name = "ClientAbortError";
  }
}

interface RequestAbortState {
  signal: AbortSignal;
  cleanup: () => void;
}

function readPageEvaluateRetries(): number {
  const value = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_PAGE_RETRIES ?? 2);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 2;
}

function readGuestTimeoutRetries(): number {
  const value = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_TIMEOUT_RETRIES ?? 1);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
}

function readMemoryPressureRetries(): number {
  const value = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_MEMORY_RETRIES ?? 1);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 1;
}

function readWasmOobRetries(): number {
  const value = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_WASM_OOB_RETRIES ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function readPageRecycleInterval(): number {
  const value = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_RECYCLE_INTERVAL ?? 25);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 25;
}

function readBrowserRecycleInterval(): number {
  const value = Number(process.env.SPIDERMONKEY_BROWSER_JS_SHELL_BROWSER_RECYCLE_INTERVAL ?? 100);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 100;
}

const PAGE_EVALUATE_RETRIES = readPageEvaluateRetries();
const GUEST_TIMEOUT_RETRIES = readGuestTimeoutRetries();
const MEMORY_PRESSURE_RETRIES = readMemoryPressureRetries();
const WASM_OOB_RETRIES = readWasmOobRetries();
const PAGE_RECYCLE_INTERVAL = readPageRecycleInterval();
const WASM_TRAP_SIGSEGV_EXIT_STATUS = 128 + 11;
const BROWSER_RECYCLE_INTERVAL = readBrowserRecycleInterval();

console.error(
  `[browser js shell bridge] config ` +
  `page_recycle_interval=${PAGE_RECYCLE_INTERVAL} ` +
  `browser_recycle_interval=${BROWSER_RECYCLE_INTERVAL} ` +
  `page_retries=${PAGE_EVALUATE_RETRIES} ` +
  `timeout_retries=${GUEST_TIMEOUT_RETRIES} ` +
  `memory_retries=${MEMORY_PRESSURE_RETRIES} ` +
  `wasm_oob_retries=${WASM_OOB_RETRIES}`,
);

let viteProcess: ChildProcess | null = null;
let browserInstance: Browser | null = null;
let httpServer: Server | null = null;
let shutdownPromise: Promise<void> | null = null;

function isPageContextLoss(message: string): boolean {
  return /Target page|Execution context|closed|detached|navigation/i.test(message);
}

function isGuestTimeoutResult(result: RunResult): boolean {
  return result.error === "TIMEOUT";
}

function isBrowserMemoryPressureMessage(message: string | undefined): boolean {
  return /WebAssembly\.Memory\(\): could not allocate memory|could not allocate memory|Out of Memory/i.test(message ?? "");
}

function isBrowserMemoryPressureResult(result: RunResult): boolean {
  return isBrowserMemoryPressureMessage(result.error) ||
    (result.exitCode < 0 && isBrowserMemoryPressureMessage(result.stderr));
}

function isWasmOobTrapMessage(message: string | undefined): boolean {
  return /memory access out of bounds/i.test(message ?? "");
}

function isWasmOobTrapResult(result: RunResult): boolean {
  if (
    result.exitCode !== WASM_TRAP_SIGSEGV_EXIT_STATUS &&
    result.exitCode >= 0
  ) {
    return false;
  }
  return isWasmOobTrapMessage(result.error) ||
    isWasmOobTrapMessage(result.stderr);
}

function requestTimeoutMs(body: RunRequest): number {
  const value = Number(body.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
    promise.then(resolvePromise, reject).finally(() => clearTimeout(timer));
  });
}

function withTimeoutOrAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(new ClientAbortError());
      return;
    }
    const onAbort = () => reject(new ClientAbortError());
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, reject).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isClientAbort(err: unknown): boolean {
  return err instanceof ClientAbortError ||
    (err instanceof Error && err.name === "ClientAbortError");
}

function throwIfClientAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ClientAbortError();
}

function childExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

async function waitForChildExit(proc: ChildProcess): Promise<void> {
  if (childExited(proc)) return;
  await new Promise<void>((resolveExit) => {
    proc.once("exit", () => resolveExit());
  });
}

function signalChild(proc: ChildProcess, signal: NodeJS.Signals): boolean {
  if (proc.pid && process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch (err: any) {
      if (err?.code !== "ESRCH") {
        console.error(`[browser js shell bridge] failed to signal child group ${proc.pid}: ${err?.message || String(err)}`);
      }
    }
  }
  return proc.kill(signal);
}

async function terminateChild(proc: ChildProcess, description: string): Promise<void> {
  if (childExited(proc)) return;

  if (!signalChild(proc, "SIGTERM")) return;
  const exited = await Promise.race([
    waitForChildExit(proc).then(() => true),
    delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
  ]);
  if (exited || childExited(proc)) return;

  console.error(`[browser js shell bridge] ${description} did not exit after SIGTERM; sending SIGKILL`);
  signalChild(proc, "SIGKILL");
  await Promise.race([
    waitForChildExit(proc),
    delay(SHUTDOWN_TIMEOUT_MS),
  ]);
}

async function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await Promise.race([
    new Promise<void>((resolveClose) => {
      server.close((err?: Error) => {
        if (err) console.error(`[browser js shell bridge] HTTP server close failed: ${err.message}`);
        resolveClose();
      });
    }),
    delay(SHUTDOWN_TIMEOUT_MS),
  ]);
}

async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (httpServer) {
      await closeHttpServer(httpServer);
      httpServer = null;
    }
    if (browserInstance) {
      await Promise.race([
        browserInstance.close().catch((err: any) => {
          console.error(`[browser js shell bridge] browser close failed: ${err?.message || String(err)}`);
        }),
        delay(SHUTDOWN_TIMEOUT_MS),
      ]);
      browserInstance = null;
    }
    if (viteProcess) {
      await terminateChild(viteProcess, "Vite server");
      viteProcess = null;
    }
  })();
  return shutdownPromise;
}

async function closePageContext(page: Page, reason: string, timeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  let timedOut = false;
  const timeout = delay(timeoutMs).then(() => {
    timedOut = true;
  });
  await Promise.race([
    page.context().close().catch((err: any) => {
      console.error(`[browser js shell bridge] page context close failed after ${reason}: ${err?.message || String(err)}`);
    }),
    timeout,
  ]);
  if (timedOut) {
    console.error(`[browser js shell bridge] page context close timed out after ${reason}`);
  }
}

function installShutdownHandlers(): void {
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(130)); });
  process.once("uncaughtException", (err) => {
    console.error(err?.stack || err?.message || String(err));
    void shutdown().finally(() => process.exit(1));
  });
  process.once("unhandledRejection", (reason: any) => {
    console.error(reason?.stack || reason?.message || String(reason));
    void shutdown().finally(() => process.exit(1));
  });
  process.once("exit", () => {
    if (viteProcess && !childExited(viteProcess)) {
      signalChild(viteProcess, "SIGTERM");
    }
  });
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
    const viteArgs = [
      "--config", join(BROWSER_DIR, "vite.config.ts"),
      "--host", VITE_HOST,
      "--port", String(VITE_PORT),
      "--strictPort",
    ];
    const hasLocalVite = existsSync(VITE_CLI);
    const proc = spawn(
      hasLocalVite ? process.execPath : "npx",
      hasLocalVite ? [VITE_CLI, ...viteArgs] : ["vite", ...viteArgs],
      {
        cwd: BROWSER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: { ...process.env, KANDELO_BROWSER_DEMO_INPUTS: "spidermonkey-test" },
      },
    );
    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        void terminateChild(proc, "Vite server after startup timeout")
          .finally(() => reject(new Error("Vite server did not start within 30s")));
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

async function listenServer(server: Server): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      reject(err);
    };
    server.once("error", onError);
    server.listen(SERVER_PORT, SERVER_HOST, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    args: ["--enable-features=SharedArrayBuffer"],
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

function createRequestAbortState(req: IncomingMessage, res: ServerResponse): RequestAbortState {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableEnded) abort();
  });
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("aborted", abort);
    },
  };
}

function readJsonBody(req: IncomingMessage, signal: AbortSignal): Promise<RunRequest> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ClientAbortError());
      return;
    }
    const chunks: Buffer[] = [];
    const onAbort = () => reject(new ClientAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      signal.removeEventListener("abort", onAbort);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

async function main() {
  installShutdownHandlers();

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

  viteProcess = await startViteServer();
  browserInstance = await launchBrowser();
  let page = await openPage(browserInstance);
  let runsSincePageOpen = 0;
  let runsSinceBrowserOpen = 0;
  let queue = Promise.resolve();

  async function reopenPage(reason: string, closeTimeoutMs = SHUTDOWN_TIMEOUT_MS): Promise<void> {
    console.error(`[browser js shell bridge] reopening page after ${reason}`);
    await closePageContext(page, reason, closeTimeoutMs);
    page = await openPage(browserInstance!);
    runsSincePageOpen = 0;
  }

  async function restartBrowser(reason: string): Promise<void> {
    console.error(`[browser js shell bridge] restarting browser after ${reason}`);
    await page.context().close().catch(() => {});
    await browserInstance?.close().catch((err: any) => {
      console.error(`[browser js shell bridge] browser close before restart failed: ${err?.message || String(err)}`);
    });
    browserInstance = await launchBrowser();
    page = await openPage(browserInstance);
    runsSincePageOpen = 0;
    runsSinceBrowserOpen = 0;
  }

  async function recycleBrowserIfNeeded(): Promise<void> {
    if (BROWSER_RECYCLE_INTERVAL === 0) return;
    if (runsSinceBrowserOpen < BROWSER_RECYCLE_INTERVAL) return;
    await restartBrowser(`${runsSinceBrowserOpen} shell invocations`);
  }

  async function recyclePageIfNeeded(): Promise<void> {
    if (PAGE_RECYCLE_INTERVAL === 0) return;
    if (runsSincePageOpen < PAGE_RECYCLE_INTERVAL) return;
    await reopenPage(`${runsSincePageOpen} shell invocations`);
  }

  async function runInPage(body: RunRequest, signal: AbortSignal): Promise<RunResult> {
    const startedAt = Date.now();
    const timeoutMs = requestTimeoutMs(body);
    let pageRetries = 0;
    let guestTimeoutRetries = 0;
    let memoryPressureRetries = 0;
    let wasmOobRetries = 0;
    for (;;) {
      throwIfClientAborted(signal);
      await recycleBrowserIfNeeded();
      await recyclePageIfNeeded();
      throwIfClientAborted(signal);
      runsSincePageOpen++;
      runsSinceBrowserOpen++;
      const evaluation = page.evaluate(
        (request) => (window as any).__runSpiderMonkeyScript(request),
        { argv: body.argv, timeoutMs: body.timeoutMs },
      ) as Promise<RunResult>;
      evaluation.catch(() => {});

      try {
        const result = await withTimeoutOrAbort(evaluation, timeoutMs, signal);
        if (isGuestTimeoutResult(result)) {
          await reopenPage(`guest timeout result (${guestTimeoutRetries}/${GUEST_TIMEOUT_RETRIES})`);
          if (guestTimeoutRetries < GUEST_TIMEOUT_RETRIES) {
            guestTimeoutRetries++;
            continue;
          }
        }
        if (isBrowserMemoryPressureResult(result)) {
          await restartBrowser(
            `browser WebAssembly memory pressure ` +
            `(${memoryPressureRetries}/${MEMORY_PRESSURE_RETRIES})`,
          );
          if (memoryPressureRetries < MEMORY_PRESSURE_RETRIES) {
            memoryPressureRetries++;
            continue;
          }
        }
        if (isWasmOobTrapResult(result)) {
          await restartBrowser(
            `browser WebAssembly OOB trap ` +
            `(${wasmOobRetries}/${WASM_OOB_RETRIES})`,
          );
          if (wasmOobRetries < WASM_OOB_RETRIES) {
            wasmOobRetries++;
            continue;
          }
        }
        if (pageRetries > 0) result.bridgeRetries = pageRetries;
        if (guestTimeoutRetries > 0) result.guestTimeoutRetries = guestTimeoutRetries;
        if (memoryPressureRetries > 0) result.memoryPressureRetries = memoryPressureRetries;
        if (wasmOobRetries > 0) result.wasmOobRetries = wasmOobRetries;
        return result;
      } catch (err: any) {
        if (isClientAbort(err)) {
          await reopenPage(
            "client disconnect during shell invocation",
            ABANDONED_REQUEST_CLOSE_TIMEOUT_MS,
          ).catch((reopenErr: any) => {
            console.error(`[browser js shell bridge] failed to reset page after client disconnect: ${reopenErr?.message || String(reopenErr)}`);
          });
          throw err;
        }
        const message = err?.message || String(err);
        if (message.includes("TIMEOUT")) {
          await reopenPage(
            `host-side guest timeout after ${timeoutMs}ms ` +
            `(${guestTimeoutRetries}/${GUEST_TIMEOUT_RETRIES})`,
          );
          if (guestTimeoutRetries < GUEST_TIMEOUT_RETRIES) {
            guestTimeoutRetries++;
            continue;
          }
          return {
            exitCode: -1,
            stdout: "",
            stderr: "",
            error: "TIMEOUT",
            durationMs: Date.now() - startedAt,
            ...(pageRetries > 0 ? { bridgeRetries: pageRetries } : {}),
            ...(guestTimeoutRetries > 0 ? { guestTimeoutRetries } : {}),
            ...(memoryPressureRetries > 0 ? { memoryPressureRetries } : {}),
            ...(wasmOobRetries > 0 ? { wasmOobRetries } : {}),
          };
        }

        if (!isPageContextLoss(message) || pageRetries >= PAGE_EVALUATE_RETRIES) {
          throw err;
        }
        pageRetries++;
        await reopenPage(
          `Playwright context loss (${pageRetries}/${PAGE_EVALUATE_RETRIES}): ${message}`,
        );
      }
    }
  }

  httpServer = createServer((req, res) => {
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

    const requestAbort = createRequestAbortState(req, res);
    queue = queue.then(async () => {
      try {
        const body = await readJsonBody(req, requestAbort.signal);
        throwIfClientAborted(requestAbort.signal);
        const result = await runInPage(body, requestAbort.signal);
        if (!requestAbort.signal.aborted && !res.destroyed) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        }
      } catch (err: any) {
        if (isClientAbort(err)) {
          console.error("[browser js shell bridge] dropped abandoned shell request after client disconnect");
          return;
        }
        const message = err?.message || String(err);
        if (isPageContextLoss(message)) {
          await reopenPage(`unrecovered Playwright error: ${message}`).catch(() => {});
        }
        if (!requestAbort.signal.aborted && !res.destroyed) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            exitCode: -1,
            stdout: "",
            stderr: "",
            error: message,
            durationMs: 0,
          }));
        }
      } finally {
        requestAbort.cleanup();
      }
    });
  });

  await listenServer(httpServer);
  console.error(`browser js shell bridge listening on http://${SERVER_HOST}:${SERVER_PORT}/run`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  void shutdown().finally(() => process.exit(1));
});
