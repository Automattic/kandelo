import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { extractZipEntry, parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import { ensureDirRecursive, writeVfsBinary } from "../../../host/src/vfs/image-helpers";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { GLES2_NEGATIVE_STATE_CASES, parseCtsQpa } from "../../../tests/graphics/cts-qpa.mjs";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

test.use({ headless: true, serviceWorkers: "block" });
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// This is one complete upstream group, not a full conformance claim.
test("upstream GLES2 negative state group through the normal renderer", async ({ page, browser, browserName, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const program = readFileSync(resolveBinary("programs/wasm32/graphics-cts/deqp-gles2.wasm"));
  const data = readFileSync(resolveBinary("programs/wasm32/graphics-cts/data.zip"));
  const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));
  const image = KandeloImageFs.create();
  image.setImageCapacity(16 * 1024 * 1024);
  for (const path of ["/bin", "/tmp", "/cts"]) ensureDirRecursive(image, path);
  writeVfsBinary(image, "/bin/deqp-gles2", program, 0o755);
  const entries = parseZipCentralDirectory(data);
  expect(entries.length).toBeLessThan(5000);
  expect(entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)).toBeLessThan(8 * 1024 * 1024);
  const names = new Set<string>();
  for (const entry of entries) {
    const parts = entry.fileName.split("/");
    if (parts[0] !== "gles2" || parts.some(part => part === ".." || part === ".")
        || entry.fileName.includes("\\") || entry.isSymlink || names.has(entry.fileName)) {
      throw new Error(`Invalid CTS data archive member: ${entry.fileName}`);
    }
    names.add(entry.fileName);
    const path = `/cts/${entry.fileName}`;
    if (entry.isDirectory) ensureDirRecursive(image, path);
    else {
      ensureDirRecursive(image, path.slice(0, path.lastIndexOf("/")));
      writeVfsBinary(image, path, extractZipEntry(data, entry), 0o644);
    }
  }
  const imageBytes = await image.saveImage();
  const kernelUrl = new URL("/__gles2_cts_kernel", baseURL).href;
  const imageUrl = new URL("/__gles2_cts_image", baseURL).href;
  await page.route(kernelUrl, route => route.fulfill({ body: kernelBytes }));
  await page.route(imageUrl, route => route.fulfill({ body: Buffer.from(imageBytes) }));
  const args = ["deqp-gles2", "--deqp-case=dEQP-GLES2.functional.negative_api.state.*",
    "--deqp-visibility=hidden", "--deqp-archive-dir=/cts", "--deqp-log-filename=/tmp/result.qpa"];
  const report: Record<string, any> = {
    scope: "Complete 31-case negative-state group; not full conformance",
    engine: browserName, version: browser.version(), args,
    artifacts: { program: sha(program), data: sha(data), kernel: sha(kernelBytes), image: sha(imageBytes) },
    expectedCases: GLES2_NEGATIVE_STATE_CASES, pageErrors: [], consoleErrors: [], cleanupErrors: [], workers: [],
  };
  page.on("pageerror", error => report.pageErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("worker", worker => {
    const row = { url: worker.url(), closed: false };
    report.workers.push(row);
    worker.on("close", () => { row.closed = true; });
  });
  await installBrowserMemoryBoundaryProbe(page);
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  let workloadFailed = false, workloadError: unknown;
  try {
    if (browserName === "chromium") {
      const cdp = await browser.newBrowserCDPSession();
      try { report.actualCommandLine = (await cdp.send("SystemInfo.getInfo")).commandLine; }
      finally { await cdp.detach(); }
      expect(report.actualCommandLine).toMatch(/(?:^|\s)--headless(?:[=\s]|$)/);
      expect(report.actualCommandLine).not.toMatch(/chromium_headless_shell|chrome-headless-shell/i);
    }
    await page.evaluate(async ({ moduleUrl, kernelUrl, imageUrl, args }) => {
      const scope = globalThis as any;
      const state = { stdout: "", stderr: "", bytes: { stdout: 0, stderr: 0 },
        overflow: false, exit: null as number | null, error: null as string | null, diagnostics: [] as unknown[] };
      scope.__gles2CtsState = state;
      const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
      const append = (stream: "stdout" | "stderr", bytes: Uint8Array) => {
        state.bytes[stream] += bytes.byteLength;
        if (state.bytes[stream] > 16 * 1024 * 1024) { state.overflow = true; return; }
        state[stream] += decoders[stream].decode(bytes, { stream: true });
      };
      const flush = () => {
        for (const stream of ["stdout", "stderr"] as const) state[stream] += decoders[stream].decode();
      };
      const { BrowserKernel } = await import(moduleUrl);
      const kernel = new BrowserKernel({ kernelOwnedFs: true, maxWorkers: 4,
        onStdout: (bytes: Uint8Array) => append("stdout", bytes),
        onStderr: (bytes: Uint8Array) => append("stderr", bytes),
        onHostDiagnostic: (diagnostic: unknown) => state.diagnostics.push(diagnostic) });
      scope.__gles2CtsKernel = kernel;
      await kernel.initFromImage({ kernelWasm: await (await fetch(kernelUrl)).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch(imageUrl)).arrayBuffer()) });
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 16;
      document.body.replaceChildren(canvas);
      kernel.kmsSetDisplaySize(1, 16, 16);
      kernel.kmsAttachCanvas(1, canvas.transferControlToOffscreen(), new SharedArrayBuffer(32), { mode: "webgl2-scanout" });
      const child = await kernel.spawnFromVfs("/bin/deqp-gles2", args, { env: [], uid: 1000, gid: 1000 });
      child.exit.then((code: number) => { flush(); state.exit = code; },
        (error: unknown) => { flush(); state.error = String(error); });
    }, { moduleUrl: new URL(`/@fs${modulePath}`, baseURL).href, kernelUrl, imageUrl, args });
    await page.waitForFunction(() => {
      const state = (globalThis as any).__gles2CtsState;
      return state && (state.exit !== null || state.error !== null || state.overflow);
    }, undefined, { timeout: 120_000 });
  } catch (error) {
    workloadFailed = true;
    workloadError = error;
    report.workloadError = String(error);
  } finally {
    try { report.guest = await page.evaluate(() => (globalThis as any).__gles2CtsState); }
    catch (error) { report.cleanupErrors.push(`snapshot: ${error}`); }
    try {
      report.qpa = await page.evaluate(async () => {
        const kernel = (globalThis as any).__gles2CtsKernel;
        if (!kernel) return null;
        const bytes = await kernel.readFileFromVfs("/tmp/result.qpa");
        if (!bytes) return null;
        if (bytes.length > 16 * 1024 * 1024) throw new Error("CTS QPA exceeds 16 MiB");
        return new TextDecoder().decode(bytes);
      });
    } catch (error) { report.cleanupErrors.push(`QPA: ${error}`); }
    try {
      report.destroyReturned = await page.evaluate(async () => {
        const scope = globalThis as any;
        if (!scope.__gles2CtsKernel) return false;
        await scope.__gles2CtsKernel.destroy();
        scope.__gles2CtsKernel = null;
        return true;
      });
    } catch (error) { report.cleanupErrors.push(`destroy: ${error}`); }
    try {
      const latest = await page.evaluate(() => (globalThis as any).__gles2CtsState);
      if (latest) report.guest = latest;
    } catch (error) { report.cleanupErrors.push(`post-destroy snapshot: ${error}`); }
    try {
      await expect.poll(() => report.workers.every((worker: any) => worker.closed), { timeout: 5000 }).toBe(true);
    } catch (error) { report.cleanupErrors.push(`worker closure: ${error}`); }
    try { report.memoryBoundaryFailures = await memoryBoundaryFailures(page); }
    catch (error) { report.cleanupErrors.push(`memory boundary: ${error}`); }
    if (typeof report.qpa === "string") {
      report.results = parseCtsQpa(report.qpa, GLES2_NEGATIVE_STATE_CASES);
      try { await testInfo.attach("upstream.qpa", { body: report.qpa, contentType: "text/plain" }); }
      catch (error) { report.cleanupErrors.push(`QPA attachment: ${error}`); }
    }
    try { await testInfo.attach("cts-evidence.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" }); }
    catch (error) { report.cleanupErrors.push(`evidence attachment: ${error}`); }
  }
  if (workloadFailed) throw workloadError;
  expect(report.guest?.exit, report.guest?.stdout).toBe(0);
  expect(report.guest?.error).toBeNull();
  expect(report.guest?.overflow).toBe(false);
  for (const key of ["missing", "unexpected", "duplicates", "incomplete"]) expect(report.results?.[key]).toEqual([]);
  expect(report.results?.rows).toHaveLength(GLES2_NEGATIVE_STATE_CASES.length);
  expect(report.results?.rows.filter((row: any) => row.status !== "Pass")).toEqual([]);
  expect(report.guest.diagnostics).toEqual([]);
  expect(report.pageErrors).toEqual([]);
  expect(report.consoleErrors).toEqual([]);
  expect(report.cleanupErrors).toEqual([]);
  expect(report.memoryBoundaryFailures).toEqual([]);
  expect(report.destroyReturned).toBe(true);
  expect(report.workers.length).toBeGreaterThanOrEqual(2);
  expect(report.workers.every((worker: any) => worker.closed)).toBe(true);
});
