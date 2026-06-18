import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);
const memoryFsModulePath = resolve(
  __dirname,
  "../../../host/src/vfs/memory-fs.ts",
);

test("WebKit BrowserKernel init waits for lazy VFS registration acknowledgement", async ({
  browserName,
  page,
  baseURL,
}) => {
  test.skip(browserName !== "webkit", "WebKit-only browser host contract");
  expect(baseURL).toBeTruthy();

  const browserKernelModuleUrl = new URL(`/@fs/${browserKernelModulePath}`, baseURL).href;
  const memoryFsModuleUrl = new URL(`/@fs/${memoryFsModulePath}`, baseURL).href;

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const result = await page.evaluate(
    async ({ browserKernelModuleUrl, memoryFsModuleUrl }) => {
      type CapturedMessage = { data: any; transfer: Transferable[] };

      class MockWorker {
        static instances: MockWorker[] = [];

        onmessage: ((e: MessageEvent) => void) | null = null;
        onerror: ((e: ErrorEvent) => void) | null = null;
        sent: CapturedMessage[] = [];
        terminated = false;
        private listeners = new Map<string, Array<(e: Event) => void>>();

        constructor(
          readonly url: string | URL,
          readonly options?: WorkerOptions,
        ) {
          MockWorker.instances.push(this);
        }

        postMessage(data: unknown, transfer: Transferable[] = []) {
          this.sent.push({ data, transfer });
        }

        addEventListener(type: string, handler: (e: Event) => void) {
          const handlers = this.listeners.get(type) ?? [];
          handlers.push(handler);
          this.listeners.set(type, handlers);
        }

        removeEventListener(type: string, handler: (e: Event) => void) {
          const handlers = this.listeners.get(type) ?? [];
          const idx = handlers.indexOf(handler);
          if (idx >= 0) handlers.splice(idx, 1);
        }

        terminate() {
          this.terminated = true;
        }

        simulateMessage(data: unknown) {
          const event = new MessageEvent("message", { data });
          this.onmessage?.(event);
          for (const handler of this.listeners.get("message") ?? []) {
            handler(event);
          }
        }

        lastMessage(type: string): any | undefined {
          for (let i = this.sent.length - 1; i >= 0; i -= 1) {
            if (this.sent[i]?.data?.type === type) return this.sent[i]!.data;
          }
          return undefined;
        }
      }

      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: MockWorker,
      });

      const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelModuleUrl);
      const { MemoryFileSystem } = await import(/* @vite-ignore */ memoryFsModuleUrl);

      const rootfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
      const rootfsImage = await rootfs.saveImage();
      const rootfsImageBuffer = rootfsImage.buffer.slice(
        rootfsImage.byteOffset,
        rootfsImage.byteOffset + rootfsImage.byteLength,
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () =>
        ({
          arrayBuffer: async () => rootfsImageBuffer.slice(0),
        }) as Response;

      try {
        const memfs = MemoryFileSystem.create(new SharedArrayBuffer(1024 * 1024));
        memfs.registerLazyFile("/bin/lazy", "/assets/lazy.wasm", 123);

        const kernel = new BrowserKernel({ memfs });
        const initPromise = kernel.init(new ArrayBuffer(8));
        let resolved = false;
        void initPromise.then(() => {
          resolved = true;
        });

        await new Promise((resolve) => setTimeout(resolve, 0));
        const worker = MockWorker.instances[0]!;
        const init = worker.lastMessage("init");
        worker.simulateMessage({ type: "ready" });
        await new Promise((resolve) => setTimeout(resolve, 0));

        const lazy = worker.lastMessage("register_lazy_files");
        const resolvedBeforeAck = resolved;
        worker.simulateMessage({
          type: "response",
          requestId: lazy.requestId,
          result: true,
        });
        await initPromise;

        return {
          initPosted: Boolean(init),
          lazyEntries: lazy.entries,
          resolvedBeforeAck,
          resolvedAfterAck: resolved,
        };
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
    { browserKernelModuleUrl, memoryFsModuleUrl },
  );

  expect(result.initPosted).toBe(true);
  expect(result.lazyEntries).toMatchObject([
    { path: "/bin/lazy", url: "/assets/lazy.wasm", size: 123 },
  ]);
  expect(result.resolvedBeforeAck).toBe(false);
  expect(result.resolvedAfterAck).toBe(true);
});
