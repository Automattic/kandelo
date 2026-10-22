/**
 * Kandelo exchange in the browser host: the same offer, activation, agent
 * and output paths that host/test/exchange-agent.test.ts runs on Node, here
 * through BrowserKernel.exchange in a real page.
 *
 * The image carries the base rootfs's exchange entries and the
 * kandelo-exchange package's real binaries. Skips when they are not built.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary, tryResolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

test.use({ serviceWorkers: "block" });

const binary = (name: string) => tryResolveBinary(`programs/kandelo-exchange/${name}.wasm`);
const kxchgd = binary("kxchgd");
const save = binary("exchange-save");
const publish = binary("kandelo-publish");
const rootfs = fileURLToPath(new URL("../../../images/rootfs", import.meta.url));
const hello = fileURLToPath(new URL("../../../examples/hello.wasm", import.meta.url));

async function exchangeImage(): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  for (const [dir, uid, gid] of [
    ["/etc", 0, 0], ["/etc/kandelo", 0, 0], ["/etc/kandelo/exchange-handlers.d", 1000, 120],
    ["/usr", 0, 0], ["/usr/bin", 0, 0], ["/usr/libexec", 0, 0], ["/usr/libexec/kandelo", 0, 0],
    ["/usr/share", 0, 0], ["/usr/share/kandelo", 0, 0], ["/usr/share/kandelo/exchange-handlers.d", 0, 0],
    ["/home", 0, 0], ["/home/maker", 1000, 1000],
  ] as const) fs.mkdirWithOwner(dir, 0o755, uid, gid);
  const file = (path: string, mode: number, bytes: Uint8Array) => fs.createFileWithOwner(path, mode, 0, 0, bytes);
  for (const path of ["/etc/passwd", "/etc/group", "/etc/kandelo/exchange.conf",
    "/usr/share/kandelo/exchange-handlers.d/99-save.handler"]) {
    file(path, 0o644, new Uint8Array(readFileSync(`${rootfs}${path}`)));
  }
  file("/usr/libexec/kandelo/exchange-agent", 0o755, new Uint8Array(readFileSync(kxchgd!)));
  file("/usr/libexec/kandelo/exchange-save", 0o755, new Uint8Array(readFileSync(save!)));
  file("/usr/bin/kandelo-publish", 0o755, new Uint8Array(readFileSync(publish!)));
  file("/usr/bin/hello", 0o755, new Uint8Array(readFileSync(hello)));
  return fs.saveImage();
}

test("offers files and streams to the agent and receives outputs in the browser", async ({ page, baseURL, browserName }) => {
  test.skip(!kxchgd || !save || !publish, "the kandelo-exchange package is not built");
  // Vite serves module workers unbundled; WebKit refuses them under COEP.
  test.skip(browserName === "webkit", "WebKit cannot load the dev-server module workers");
  const kernelUrl = new URL("/__exchange_kernel.wasm", baseURL).href;
  const imageUrl = new URL("/__exchange_image.vfs", baseURL).href;
  const imageBytes = await exchangeImage();
  await page.route(kernelUrl, (route) => route.fulfill({ body: readFileSync(resolveBinary("kernel.wasm")) }));
  await page.route(imageUrl, (route) => route.fulfill({ body: Buffer.from(imageBytes) }));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));

  const result = await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl }) => {
    const { BrowserKernel } = await import(moduleUrl);
    let stderr = "";
    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
    });
    const text = (bytes: Uint8Array | null) => (bytes ? new TextDecoder().decode(bytes) : null);
    try {
      await kernel.initFromImage({
        kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()),
      });
      const consumerBefore = await kernel.exchange.consumerState();

      // Into the machine: a file and a stream, saved by the vendor catch-all.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("streamed "));
          controller.enqueue(new TextEncoder().encode("in the browser"));
          controller.close();
        },
      });
      const batch = await kernel.exchange.offer([
        { name: "notes.txt", source: new Blob(["from the browser"]) },
        { name: "feed.log", source: stream },
      ], { source: "drop" });
      const settled = await batch.settled;
      const saved = text(await kernel.readFileFromVfs("/home/maker/Downloads/notes.txt"));
      const streamed = text(await kernel.readFileFromVfs("/home/maker/Downloads/feed.log"));

      // Out of the machine: a stored and a streamed output.
      const outputs: Record<string, { kind: string; text: string }> = {};
      const listening = new AbortController();
      kernel.exchange.onOutput(async (output: { name: string; kind: string; read(): ReadableStream<Uint8Array> }) => {
        outputs[output.name] = { kind: output.kind, text: await new Response(output.read()).text() };
      }, { signal: listening.signal });
      await kernel.writeFileToVfs("/tmp/report.txt", new TextEncoder().encode("a report"));
      const stored = await kernel.spawnFromVfs("/usr/bin/kandelo-publish", ["kandelo-publish", "/tmp/report.txt"]);
      const storedExit = await stored.exit;
      const streaming = await kernel.spawnFromVfs("/usr/bin/kandelo-publish",
        ["kandelo-publish", "--stream", "--name", "hello.txt", "--", "/usr/bin/hello"]);
      const streamExit = await streaming.exit;
      const deadline = Date.now() + 20_000;
      while (Object.keys(outputs).length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      listening.abort();
      return { consumerBefore, settled, saved, streamed, storedExit, streamExit, outputs, stats: kernel.exchange.stats(), stderr };
    } finally {
      await kernel.destroy();
    }
  }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href, kernelUrl, imageUrl });

  expect(result.consumerBefore).toEqual({ state: "idle", activation: "on-demand" });
  expect(result.settled).toEqual({ outcome: "removed", status: "saved 2 items to ~/Downloads/" });
  expect(result.saved).toBe("from the browser");
  expect(result.streamed).toBe("streamed in the browser");
  expect([result.storedExit, result.streamExit], result.stderr).toEqual([0, 0]);
  expect(result.outputs["report.txt"]).toEqual({ kind: "stored", text: "a report" });
  expect(result.outputs["hello.txt"]?.kind).toBe("stream");
  expect(result.outputs["hello.txt"]?.text).toMatch(/^Hello/);
  expect(result.stats).toMatchObject({ sources: 0, batches: 0 });
});
