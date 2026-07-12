import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tryResolveBinary } from "../../../host/src/binary-resolver";
import { ABI_VERSION } from "../../../host/src/generated/abi";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerModulePath = resolve(
  __dirname,
  "fixtures/lazy-vfs-integrity-worker.ts",
);
const kernelWorkerModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-worker-entry.ts",
);
const processWorkerModulePath = resolve(
  __dirname,
  "../../../host/src/worker-entry-browser.ts",
);
async function lazyExecImage(
  assetUrl: string,
  helloSize: number,
  shellBytes: Uint8Array,
): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  fs.mkdir("/bin", 0o755);
  fs.mkdir("/usr", 0o755);
  fs.mkdir("/usr/bin", 0o755);
  fs.createFileWithOwner(
    "/bin/sh",
    0o755,
    0,
    0,
    shellBytes,
  );
  fs.registerLazyFile("/usr/bin/hello", assetUrl, helloSize, 0o755);
  return fs.saveImage({ metadata: { version: 1, kernelAbi: ABI_VERSION } });
}

test("kernel-owned lazy VFS rejects wrong-sized bytes and can retry", async ({
  page,
  baseURL,
  browserName,
}) => {
  expect(baseURL).toBeTruthy();
  const workerUrl = new URL(`/@fs/${workerModulePath}`, baseURL).href;
  const assetUrl = new URL("/__lazy_integrity__/tool.wasm", baseURL).href;
  const exactBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  let requestCount = 0;

  await page.route("**/__lazy_integrity__/tool.wasm", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Vite fallback</title>",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/wasm",
      body: Buffer.from(exactBytes),
    });
  });

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(
    async ({ workerUrl, assetUrl, expectedBytes }) => {
      const worker = new Worker(workerUrl, { type: "module" });
      try {
        return await new Promise<{
          fatalError?: string;
          firstError: string;
          retained: { size: number } | null;
          stubRead: number;
          retried: boolean;
          bytesRead: number;
          bytes: number[];
          remainingEntry: unknown;
          statuses: string[];
        }>((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage({ assetUrl, expectedBytes });
        });
      } finally {
        worker.terminate();
      }
    },
    { workerUrl, assetUrl, expectedBytes: exactBytes.byteLength },
  );

  expect(result.fatalError, browserName).toBeUndefined();
  expect(result.firstError, browserName).toContain(
    `expected ${exactBytes.byteLength} bytes, received 43`,
  );
  expect(result.retained, browserName).toMatchObject({ size: exactBytes.byteLength });
  expect(result.stubRead, browserName).toBe(0);
  expect(result.retried, browserName).toBe(true);
  expect(result.bytesRead, browserName).toBe(exactBytes.byteLength);
  expect(result.bytes, browserName).toEqual([...exactBytes]);
  expect(result.remainingEntry, browserName).toBeNull();
  expect(result.statuses, browserName).toEqual([
    "started",
    "progress",
    "error",
    "started",
    "progress",
    "complete",
  ]);
  expect(requestCount, browserName).toBe(2);
});

test("browser kernel reports lazy exec integrity failures as EIO and retries", async ({
  page,
  baseURL,
  browserName,
}) => {
  expect(baseURL).toBeTruthy();
  const kernelPath = tryResolveBinary("kernel.wasm");
  expect(
    kernelPath,
    "kernel.wasm is required; build or fetch the current ABI kernel before browser tests",
  ).toBeTruthy();
  const shellPath = tryResolveBinary("programs/wasm32/dash.wasm");
  expect(
    shellPath,
    "dash.wasm is required; fetch the current ABI package before browser tests",
  ).toBeTruthy();
  const helloPath = tryResolveBinary("programs/wasm32/hello.wasm");
  expect(
    helloPath,
    "hello.wasm is required; fetch the current ABI package before browser tests",
  ).toBeTruthy();

  const helloBytes = new Uint8Array(readFileSync(helloPath!));
  const shellBytes = new Uint8Array(readFileSync(shellPath!));
  const assetUrl = new URL("/__lazy_integrity__/exec-hello.wasm", baseURL).href;
  const kernelUrl = new URL("/__lazy_integrity__/kernel.wasm", baseURL).href;
  const imageUrl = new URL("/__lazy_integrity__/rootfs.vfs", baseURL).href;
  const image = await lazyExecImage(assetUrl, helloBytes.byteLength, shellBytes);
  let assetRequests = 0;

  await page.route(kernelUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/wasm",
    body: readFileSync(kernelPath!),
  }));
  await page.route(imageUrl, (route) => route.fulfill({
    status: 200,
    contentType: "application/octet-stream",
    body: Buffer.from(image),
  }));
  await page.route(assetUrl, async (route) => {
    assetRequests += 1;
    if (assetRequests === 1) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Vite fallback</title>",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/wasm",
      body: Buffer.from(helloBytes),
    });
  });

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(
    async ({
      kernelUrl,
      imageUrl,
      kernelWorkerUrl,
      processWorkerUrl,
      memoryFsUrl,
    }) => {
      const [{ MemoryFileSystem }, kernelResponse, imageResponse] = await Promise.all([
        import(/* @vite-ignore */ memoryFsUrl),
        fetch(kernelUrl),
        fetch(imageUrl),
      ]);
      const kernelBytes = await kernelResponse.arrayBuffer();
      const vfsImage = new Uint8Array(await imageResponse.arrayBuffer());
      const shmSab = new SharedArrayBuffer(1024 * 1024);
      MemoryFileSystem.create(shmSab);

      const worker = new Worker(kernelWorkerUrl, { type: "module" });
      const stdout: string[] = [];
      const stderr: string[] = [];
      const lazyStatuses: string[] = [];
      const responses = new Map<number, {
        resolve: (result: unknown) => void;
        reject: (error: Error) => void;
      }>();
      const exited = new Map<number, number>();
      const exitWaiters = new Map<number, (status: number) => void>();
      let nextRequestId = 1;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const decoder = new TextDecoder();

      worker.onmessage = ({ data }) => {
        if (data.type === "ready") {
          resolveReady();
        } else if (data.type === "init_error") {
          rejectReady(new Error(data.error));
        } else if (data.type === "response") {
          const pending = responses.get(data.requestId);
          if (!pending) return;
          responses.delete(data.requestId);
          if (data.error) pending.reject(new Error(data.error));
          else pending.resolve(data.result);
        } else if (data.type === "exit") {
          const waiter = exitWaiters.get(data.pid);
          if (waiter) {
            exitWaiters.delete(data.pid);
            waiter(data.status);
          } else {
            exited.set(data.pid, data.status);
          }
        } else if (data.type === "stdout") {
          stdout.push(decoder.decode(data.data));
        } else if (data.type === "stderr") {
          stderr.push(decoder.decode(data.data));
        } else if (data.type === "lazy_download") {
          lazyStatuses.push(data.event.status);
        }
      };

      const request = <T,>(message: Record<string, unknown>): Promise<T> => {
        const requestId = nextRequestId++;
        return new Promise<T>((resolve, reject) => {
          responses.set(requestId, {
            resolve: (value) => resolve(value as T),
            reject,
          });
          worker.postMessage({ ...message, requestId });
        });
      };
      const waitForExit = (pid: number): Promise<number> => {
        const status = exited.get(pid);
        if (status !== undefined) {
          exited.delete(pid);
          return Promise.resolve(status);
        }
        return new Promise((resolve) => exitWaiters.set(pid, resolve));
      };

      try {
        worker.postMessage({
          type: "init",
          kernelWasmBytes: kernelBytes,
          vfsImage,
          lazyUrlBase: new URL("/", location.href).href,
          shmSab,
          workerEntryUrl: processWorkerUrl,
          config: {
            maxWorkers: 4,
            maxMemoryPages: 4096,
            defaultThreadSlots: 16,
            env: ["PATH=/usr/bin:/bin", "HOME=/root", "TMPDIR=/tmp"],
          },
        }, [kernelBytes]);
        await ready;

        const run = async (): Promise<number> => {
          const pid = await request<number>({
            type: "spawn",
            programPath: "/bin/sh",
            argv: ["sh", "-c", "/usr/bin/hello"],
            env: ["PATH=/usr/bin:/bin", "HOME=/root", "TMPDIR=/tmp"],
            stdin: new Uint8Array(),
            maxPages: 4096,
          });
          return waitForExit(pid);
        };

        const firstExit = await run();
        const secondExit = await run();
        await request({ type: "destroy" });
        return {
          firstExit,
          secondExit,
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          lazyStatuses,
        };
      } finally {
        worker.terminate();
      }
    },
    {
      kernelUrl,
      imageUrl,
      kernelWorkerUrl: new URL(`/@fs/${kernelWorkerModulePath}`, baseURL).href,
      processWorkerUrl: new URL(`/@fs/${processWorkerModulePath}`, baseURL).href,
      memoryFsUrl: new URL(
        `/@fs/${resolve(__dirname, "../../../host/src/vfs/memory-fs.ts")}`,
        baseURL,
      ).href,
    },
  );

  expect(result.firstExit, browserName).not.toBe(0);
  expect(result.secondExit, browserName).toBe(0);
  expect(result.stderr, browserName).toContain("I/O error");
  expect(result.stdout, browserName).toContain("Hello, world!");
  const lifecycle = result.lazyStatuses.filter(
    (status, index, statuses) => status !== "progress" || statuses[index - 1] !== "progress",
  );
  expect(lifecycle, browserName).toEqual([
    "started",
    "progress",
    "error",
    "started",
    "progress",
    "complete",
  ]);
  expect(assetRequests, browserName).toBe(2);
});
