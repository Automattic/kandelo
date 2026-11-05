import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

test("lost native replies settle on shutdown and OPFS writes survive strict reopen", async ({ playwright, browserName, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const profile = mkdtempSync(join(tmpdir(), "kandelo-rpc-shutdown-"));
  const filesystem = KandeloImageFs.create();
  filesystem.writeFile("/pending", new Uint8Array([1, 2, 3]), 0o600);
  const image = await filesystem.saveImage();
  const project = testInfo.project.use;
  const context = await playwright[browserName].launchPersistentContext(profile, {
    ...project.launchOptions, channel: project.channel, proxy: project.proxy,
    extraHTTPHeaders: project.extraHTTPHeaders, serviceWorkers: "block",
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const kernelUrl = new URL("/__rpc_shutdown_kernel.wasm", baseURL).href;
    const imageUrl = new URL("/__rpc_shutdown_image.vfs", baseURL).href;
    await page.route(kernelUrl, route => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
    await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(image) }));
    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(() => (window as unknown as { __testRunnerReady?: boolean }).__testRunnerReady === true);
    const module = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
    const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
      const NativeWorker = window.Worker;
      let allHeld!: () => void;
      const repliesHeld = new Promise<void>(resolve => { allHeld = resolve; });
      let heldCount = 0;
      let heldRead: number[] | undefined;
      window.Worker = class extends NativeWorker {
        private blocked = new Set<number>();
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener("message", event => {
            const message = event.data;
            if (message?.type !== "response" || !this.blocked.has(message.requestId)) return;
            event.stopImmediatePropagation();
            this.blocked.delete(message.requestId);
            if (message.result instanceof Uint8Array) heldRead = Array.from(message.result);
            if (++heldCount === 2) allHeld();
          }, true);
        }
        override postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
          const request = message as { type?: string; requestId?: number; path?: string; request?: { url?: string } };
          if ((request.type === "read_vfs_file" && request.path === "/pending") ||
            (request.type === "http_request" && request.request?.url === "/pending")) {
            if (typeof request.requestId !== "number" || this.blocked.size === 2) throw new Error("Invalid shutdown transport fixture request");
            this.blocked.add(request.requestId);
          }
          if (Array.isArray(transfer)) super.postMessage(message, transfer);
          else super.postMessage(message, transfer);
        }
      };
      const { BrowserKernel } = await import(moduleUrl);
      const wasm = await (await fetch(kernelUrl)).arrayBuffer();
      const image = new Uint8Array(await (await fetch(imageUrl)).arrayBuffer());
      const name = `rpc-shutdown-${crypto.randomUUID()}`;
      const options = { kernelWasm: wasm, vfsImage: image, experimentalResizablePersistenceName: name,
        persistentComputerName: name };
      const kernel = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024 });
      let recovered: InstanceType<typeof BrowserKernel> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await kernel.initFromImage(options);
        await kernel.writeFileToVfs("/state", new TextEncoder().encode("before shutdown"), 0o600);
        const outcomes = Promise.allSettled([
          kernel.readFileFromVfs("/pending"),
          kernel.fetchInKernel(80, { method: "GET", url: "/pending", headers: {}, body: null }),
        ]);
        await Promise.race([repliesHeld, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Native replies did not reach the transport fixture")), 10_000);
        })]);
        clearTimeout(timer);
        await kernel.destroy();
        const errors = (await outcomes).map(outcome => outcome.status === "rejected" ? String(outcome.reason.message) : "unexpected success");
        const failure = kernel.getPersistenceShutdownFailure();
        const uncertain = kernel.hasUnconfirmedKernelQuiescence();
        let refusedAfterClose = false;
        try { await kernel.fetchInKernel(80, { method: "GET", url: "/after-close", headers: {}, body: null }); }
        catch (error) { refusedAfterClose = error instanceof Error && error.message === "kernel host is not accepting requests"; }
        recovered = new BrowserKernel({ kernelOwnedFs: true, kernelMaxPages: 1024, maxMemoryPages: 1024 });
        await recovered.initFromImage({ ...options, requireExistingRootfsPersistence: true });
        const saved = new TextDecoder().decode(await recovered.readFileFromVfs("/state"));
        return { heldRead, heldCount, errors, failure, uncertain, refusedAfterClose, saved };
      } finally {
        clearTimeout(timer);
        await kernel.destroy();
        await recovered?.destroy();
        window.Worker = NativeWorker;
      }
    }, { moduleUrl: new URL(`/@fs/${module}`, baseURL).href, kernelUrl, imageUrl });
    expect(result).toEqual({ heldRead: [1, 2, 3], heldCount: 2, errors: ["kernel host destroyed", "kernel host destroyed"],
      failure: null, uncertain: false, refusedAfterClose: true, saved: "before shutdown" });
  } finally {
    await context.close();
    filesystem.reset();
    rmSync(profile, { recursive: true, force: true });
  }
});
