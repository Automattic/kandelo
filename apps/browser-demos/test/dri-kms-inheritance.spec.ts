/** An actual forked guest presents its inherited cursor after opener retirement. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { compileSdkFixture } from "../../../host/test/support/compile-sdk-fixture";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

test.use({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });
let fixture: ReturnType<typeof compileSdkFixture>;
const evidenceBase = fileURLToPath(new URL("../../../.context/graphics-abi56-format-evidence/", import.meta.url));
let evidenceRoot = evidenceBase;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
test.beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../../host/test/fixtures/dri-kms-inheritance.c", import.meta.url), [
    "-DTEST_EGL_RENDER",
    `-I${fileURLToPath(new URL("../../../sysroot/include/drm", import.meta.url))}`,
    "-lEGL", "-lGLESv2", "-lgbm", "-ldrm",
  ], {
    forkInstrument: true,
  });
  // Preserve earlier runs even when the kernel/host changes but the guest
  // source does not. An evidence record must keep its exact compiled bytes.
  evidenceRoot = join(evidenceBase, `run-${Date.now()}-${test.info().project.name}`);
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, `inherited-probe-${test.info().project.name}.wasm`), readFileSync(fixture.programPath));
});
test.afterAll(() => fixture?.cleanup());

for (const mode of ["cursor", "render", "render-node", "render-node-2d"]) {
  test(`inherited master presents ${mode} after the opener Worker exits`, async ({ page, baseURL, browser }) => {
    test.setTimeout(60_000);
    const image = KandeloImageFs.create();
    image.mkdir("/bin", 0o755);
    image.writeFile("/bin/probe", readFileSync(fixture.programPath), 0o755);
    const imageBytes = await image.saveImage();
    await page.route("**/__kms_inherited_kernel", route => route.fulfill({
      body: readFileSync(resolveBinary("kernel.wasm")),
    }));
    await page.route("**/__kms_inherited_image", route => route.fulfill({ body: Buffer.from(imageBytes) }));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
    const samples: Record<string, unknown> = {};
    try {
      const prepared = await page.evaluate(async ({ moduleUrl, mode }) => {
        const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
        const state = { stdout: "", stderr: "", diagnostics: [] as unknown[], childPid: 0, openerPid: 0 };
        let resolveReady!: () => void;
        const ready = new Promise<void>(resolve => { resolveReady = resolve; });
        let resolveUnpresented!: () => void;
        const unpresented = new Promise<void>(resolve => { resolveUnpresented = resolve; });
        let resolveInterlude!: () => void;
        const interlude = new Promise<void>(resolve => { resolveInterlude = resolve; });
        let resolveExit!: (status: number | undefined) => void;
        const childExit = new Promise<number | undefined>(resolve => { resolveExit = resolve; });
        const kernel = new BrowserKernel({
          kernelOwnedFs: true,
          onStdout: (data: Uint8Array) => {
            state.stdout += new TextDecoder().decode(data);
            const match = state.stdout.match(/kms-inherited-child=(\d+)/);
            if (match) state.childPid = Number(match[1]);
            if (state.stdout.includes(`inherited ${mode} after opener retirement: ready`)) resolveReady();
            if (state.stdout.includes("render-node CPU interlude ready")) resolveInterlude();
            if (state.stdout.includes("render-node unpresented resource ready")) resolveUnpresented();
          },
          onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
          onHostDiagnostic: (diagnostic: unknown) => state.diagnostics.push(diagnostic),
          onProcessEvent: (event: { kind: string; pid: number; exitStatus?: number }) => {
            if (event.kind === "exit" && event.pid === state.childPid) resolveExit(event.exitStatus);
          },
        });
        (globalThis as any).__kmsInheritance = { kernel, state, childExit, ready, interlude };
        await kernel.initFromImage({
          kernelWasm: await (await fetch("/__kms_inherited_kernel")).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch("/__kms_inherited_image")).arrayBuffer()),
        });
        const scene = document.createElement("canvas"), cursor = document.createElement("canvas");
        scene.id = "inherited-scene";
        scene.style.backgroundColor = "black";
        scene.width = cursor.width = 640;
        scene.height = cursor.height = 480;
        cursor.id = "inherited-cursor";
        // These are two planes of one display, not two stacked displays.
        // Keep both visible while screenshots inspect either plane; scrolling
        // between them would change the visibility of the live scanout.
        const display = document.createElement("div");
        display.style.cssText = "position:relative;width:640px;height:480px";
        for (const plane of [scene, cursor]) {
          plane.style.position = "absolute";
          plane.style.left = plane.style.top = "0";
          display.appendChild(plane);
        }
        document.body.replaceChildren(display);
        kernel.kmsSetDisplaySize(1, 640, 480);
        kernel.kmsAttachCanvas(1, scene.transferControlToOffscreen(), new SharedArrayBuffer(32), {
          mode: mode === "cursor" || mode === "render-node-2d" ? "2d" : "webgl2-scanout",
          cursorCanvas: cursor.transferControlToOffscreen(),
        });
        const opener = await kernel.spawnFromVfs("/bin/probe", ["probe", mode], { uid: 1000, gid: 1000 });
        state.openerPid = opener.pid;
        const openerStatus = await opener.exit;
        if (openerStatus !== 0 || !state.childPid) throw new Error(JSON.stringify({ ...state, openerStatus }));
        await kernel.terminateProcess(opener.pid, 0);
        // The registered input stream outlives its opener while inherited
        // read ends survive. Do not infer that stream from the new PPID.
        kernel.appendStdinData(opener.pid, new TextEncoder().encode("g"));
        const stages = [ready.then(() => "ready")];
        if (mode.startsWith("render-node")) stages.push(unpresented.then(() => "unpresented"));
        const stage = await Promise.race([...stages, childExit.then(status => {
          throw new Error(`Inherited child exited early (${status}): ${JSON.stringify(state)}`);
        })]);
        return { ...state, openerStatus, stage };
      }, { moduleUrl: new URL(`/@fs${modulePath}`, baseURL).href, mode });
      expect(prepared.stderr).toBe("");
      const sampleCanvas = async (selector: string, x: number, y: number) => {
        const start = Date.now();
        samples[selector] = { x, y, stage: "capture requested" };
        const png = await page.locator(selector).screenshot({ scale: "css" });
        samples[selector] = { x, y, stage: "captured", elapsed: Date.now() - start };
        const pixel = await page.evaluate(async ({ encoded, x, y }) => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), c => c.charCodeAt(0)),
          ], { type: "image/png" }));
          const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          const pixel = Array.from(context.getImageData(x, y, 1, 1).data);
          bitmap.close();
          return pixel;
        }, { encoded: png.toString("base64"), x, y });
        samples[selector] = { x, y, stage: "sampled", pixel, elapsed: Date.now() - start };
        return pixel;
      };
      if (prepared.stage === "unpresented") {
        await expect.poll(() => sampleCanvas("#inherited-scene", 320, 240), { timeout: 10_000 })
          .toEqual([0, 0, 0, 255]);
        await page.evaluate(async () => {
          const { kernel, state, interlude, childExit } = (globalThis as any).__kmsInheritance;
          kernel.appendStdinData(state.openerPid, new TextEncoder().encode("r"));
          await Promise.race([interlude, childExit.then((status: number) => {
            throw new Error(`Render-node child exited (${status}): ${JSON.stringify(state)}`);
          })]);
        });
      }
      if (prepared.stage === "unpresented" || prepared.stage === "interlude") {
        await expect.poll(() => sampleCanvas("#inherited-scene", 320, 240), { timeout: 10_000 })
          .toEqual([0, 0, 255, 255]);
        await page.locator("#inherited-scene").screenshot({ scale: "css",
          path: join(evidenceRoot, `${test.info().project.name}-${mode}-cpu-interlude.png`) });
        await page.evaluate(async () => {
          const { kernel, state, ready, childExit } = (globalThis as any).__kmsInheritance;
          kernel.appendStdinData(state.openerPid, new TextEncoder().encode("c"));
          await Promise.race([ready, childExit.then((status: number) => {
            throw new Error(`Render-node child exited (${status}): ${JSON.stringify(state)}`);
          })]);
        });
      }
      await expect.poll(() => sampleCanvas("#inherited-cursor", 35, 45), { timeout: 10_000 })
        .toEqual([0, 255, 0, 255]);
      if (mode !== "cursor") {
        await expect.poll(() => sampleCanvas("#inherited-scene", 320, 240), { timeout: 10_000 })
          .toEqual([255, 0, 0, 255]);
      }
      if (mode.startsWith("render-node")) {
        await expect.poll(() => sampleCanvas("#inherited-scene", 17, 19), { timeout: 10_000 })
          .toEqual([255, 255, 255, 255]);
      }
      const evidenceName = `${test.info().project.name}-inherited-${mode}`;
      const screenshot = await page.locator(mode !== "cursor" ? "#inherited-scene" : "#inherited-cursor").screenshot({
        scale: "css", path: join(evidenceRoot, `${evidenceName}.png`),
      });
      writeFileSync(join(evidenceRoot, `${evidenceName}.json`), JSON.stringify({
        engine: test.info().project.name, version: browser.version(), mode,
        kernelSha256: sha256(readFileSync(resolveBinary("kernel.wasm"))),
        guestSha256: sha256(readFileSync(fixture.programPath)), screenshotSha256: sha256(screenshot),
        openerStatus: prepared.openerStatus, openerPid: prepared.openerPid, childPid: prepared.childPid,
        pixelAssertion: mode.startsWith("render-node")
          ? "unselected black, CPU interlude blue, GPU red with white marker (17,19), inherited green cursor"
          : mode !== "cursor" ? "red scene and inherited green cursor" : "inherited green cursor",
      }, null, 2) + "\n");
      const result = await page.evaluate(async () => {
        const { kernel, state, childExit } = (globalThis as any).__kmsInheritance;
        kernel.appendStdinData(state.openerPid, new TextEncoder().encode("q"));
        const childStatus = await childExit;
        await kernel.terminateProcess(state.childPid, 0);
        return { ...state, childStatus };
      });
      expect(result.childStatus, JSON.stringify(result)).toBe(0);
      expect(result.stdout).toContain("inherited KMS file: ok");
      expect(result.stderr).toBe("");
      expect(result.diagnostics).toEqual([]);
    } catch (error) {
      const state = await page.evaluate(() => (globalThis as any).__kmsInheritance?.state).catch(() => null);
      const base = `${test.info().project.name}-inherited-${mode}-failure`;
      writeFileSync(join(evidenceRoot, `${base}.json`), JSON.stringify({ state, samples, errors }, null, 2) + "\n");
      await page.locator("#inherited-scene").screenshot({ scale: "css",
        path: join(evidenceRoot, `${base}.png`), timeout: 5_000 }).catch(() => {});
      throw error;
    } finally {
      await page.evaluate(async () => {
        await (globalThis as any).__kmsInheritance?.kernel.destroy();
      });
    }
    expect(await page.evaluate(() => (globalThis as any).__kmsInheritance.state.diagnostics)).toEqual([]);
    expect(errors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}
