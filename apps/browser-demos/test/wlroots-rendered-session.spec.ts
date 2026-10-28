/** Focused package consumers, independent of the larger gallery/SDK image. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { compositorBytes, sessionRootfs } from "../../../host/test/wlroots-session";
import { installBrowserMemoryBoundaryProbe, memoryBoundaryFailures } from "./support/browser-memory-boundary";

test.use({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });
const bytes = (name: string) => new Uint8Array(readFileSync(resolveBinary(name)));
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

for (const compositor of ["cage", "sway"] as const) {
  test(`${compositor} renders a normal client through GLES2, routes input and exits`, async ({ page, baseURL, browser }) => {
    test.setTimeout(180_000);
    const client = bytes("programs/wlclient-test.wasm");
    const program = new Uint8Array(compositorBytes(compositor));
    const files = [
      { path: `/usr/bin/${compositor}`, bytes: program, mode: 0o755 },
      { path: "/usr/bin/wlclient-test", bytes: client, mode: 0o755 },
    ];
    if (compositor === "sway") files.push(
      { path: "/bin/sh", bytes: bytes("programs/dash.wasm"), mode: 0o755 },
      { path: "/usr/bin/swaymsg", bytes: bytes("programs/sway/swaymsg.wasm"), mode: 0o755 },
      { path: "/usr/bin/swaybg", bytes: bytes("programs/swaybg.wasm"), mode: 0o755 },
      { path: "/usr/bin/uname", bytes: bytes("programs/coreutils.wasm"), mode: 0o755 },
      { path: "/usr/share/fonts/Inconsolata-Regular.ttf", bytes: new Uint8Array(readFileSync(
        new URL("../../../third_party/Inconsolata-Regular.ttf", import.meta.url))), mode: 0o644 },
      { path: "/etc/fonts/fonts.conf", bytes: new TextEncoder().encode(
        '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>' +
        '<dir>/usr/share/fonts</dir><cachedir>/tmp/fontconfig</cachedir>' +
        '<alias><family>monospace</family><prefer><family>Inconsolata</family></prefer></alias></fontconfig>'), mode: 0o644 },
      { path: "/etc/sway/config", bytes: new TextEncoder().encode(
        "font pango:monospace 10\ndefault_border none\nexec /usr/bin/wlclient-test\n"), mode: 0o644 },
    );
    const image = await sessionRootfs(compositor, files);
    const kernelBytes = bytes("kernel.wasm");
    await page.route("**/__ports_kernel", route => route.fulfill({ body: Buffer.from(kernelBytes) }));
    await page.route("**/__ports_image", route => route.fulfill({ body: Buffer.from(image) }));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await installBrowserMemoryBoundaryProbe(page);
    await page.goto(new URL("/trap-signal-test.html", baseURL).href);
    const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
    const evidenceRoot = fileURLToPath(new URL("../../../.context/wlroots-rendered-sessions/", import.meta.url));
    mkdirSync(evidenceRoot, { recursive: true });
    const evidenceName = `${Date.now()}-${test.info().project.name}-${compositor}`;
    try {
      await page.evaluate(async ({ url, compositor }) => {
        const { BrowserKernel } = await import(/* @vite-ignore */ url);
        const state = { stdout: "", stderr: "", diagnostics: [] as unknown[] };
        const kernel = new BrowserKernel({ kernelOwnedFs: true,
          onStdout: (data: Uint8Array) => { state.stdout += new TextDecoder().decode(data); },
          onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
          onHostDiagnostic: (value: unknown) => state.diagnostics.push(value),
        });
        (globalThis as any).__portsSession = { kernel, state };
        await kernel.initFromImage({
          kernelWasm: await (await fetch("/__ports_kernel")).arrayBuffer(),
          vfsImage: new Uint8Array(await (await fetch("/__ports_image")).arrayBuffer()),
        });
        const scene = document.createElement("canvas"), cursor = document.createElement("canvas");
        scene.id = "ports-scene";
        scene.width = cursor.width = 640; scene.height = cursor.height = 480;
        const display = document.createElement("div");
        display.style.cssText = "position:relative;width:640px;height:480px;background:black";
        for (const plane of [scene, cursor]) {
          plane.style.cssText = "position:absolute;left:0;top:0";
          display.appendChild(plane);
        }
        document.body.replaceChildren(display);
        const stats = new Int32Array(new SharedArrayBuffer(36));
        kernel.setInputCanvasDims(640, 480);
        kernel.kmsSetDisplaySize(1, 640, 480);
        kernel.kmsAttachCanvas(1, scene.transferControlToOffscreen(), stats.buffer, {
          mode: "webgl2-scanout", cursorCanvas: cursor.transferControlToOffscreen(),
        });
        const env = ["LIBSEAT_BACKEND=noop", "WLR_RENDERER=gles2", "XDG_RUNTIME_DIR=/tmp",
          "PATH=/usr/bin:/bin", "HOME=/tmp", "SWAYSOCK=/tmp/sway-ipc.sock"];
        const root = await kernel.spawnFromVfs(`/usr/bin/${compositor}`,
          compositor === "cage" ? ["cage", "--", "/usr/bin/wlclient-test"] : ["sway"],
          { env, cwd: "/tmp", uid: 1000, gid: 1000 });
        Object.assign((globalThis as any).__portsSession, { root, env, stats });
      }, { url: new URL(`/@fs${modulePath}`, baseURL).href, compositor });
      await expect.poll(() => page.evaluate(() => (globalThis as any).__portsSession.state.stdout),
        { timeout: 90_000 }).toContain("CLIENT_READY\n");
      await expect.poll(() => page.evaluate(() => Atomics.load((globalThis as any).__portsSession.stats, 7)),
        { timeout: 30_000 }).toBe(3);
      await expect.poll(() => page.evaluate(() => Atomics.load((globalThis as any).__portsSession.stats, 5)),
        { timeout: 30_000 }).toBeGreaterThan(0);
      let visible = { count: 0, x: 0, y: 0 };
      await expect.poll(async () => {
        const png = await page.locator("#ports-scene").screenshot({ scale: "css" });
        visible = await page.evaluate(async encoded => {
          const bitmap = await createImageBitmap(new Blob([
            Uint8Array.from(atob(encoded), value => value.charCodeAt(0)),
          ], { type: "image/png" }));
          const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
          let count = 0, x = 0, y = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] !== 255 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0) continue;
            count++; x += (i / 4) % bitmap.width; y += Math.floor(i / 4 / bitmap.width);
          }
          bitmap.close();
          return { count, x: count ? Math.round(x / count) : 0, y: count ? Math.round(y / count) : 0 };
        }, png.toString("base64"));
        return visible.count;
      }, { timeout: 30_000 }).toBeGreaterThan(10_000);
      await page.locator("#ports-scene").screenshot({ scale: "css", path: `${evidenceRoot}/${evidenceName}.png` });
      await page.evaluate(({ x, y }) => {
        const { kernel } = (globalThis as any).__portsSession;
        kernel.injectInputEvent(1, 3, 0, x); kernel.injectInputEvent(1, 3, 1, y);
        kernel.injectInputEvent(1, 0, 0, 0);
        kernel.injectInputEvent(1, 1, 0x110, 1); kernel.injectInputEvent(1, 0, 0, 0);
        kernel.injectInputEvent(0, 1, 30, 1); kernel.injectInputEvent(0, 0, 0, 0);
      }, visible);
      await expect.poll(() => page.evaluate(() => (globalThis as any).__portsSession.state.stdout),
        { timeout: 30_000 }).toContain("CLIENT_OK key=30 btn=272");
      const result = await page.evaluate(async compositor => {
        const { kernel, root, env, state, stats } = (globalThis as any).__portsSession;
        if (compositor === "sway") {
          const ipc = await kernel.spawnFromVfs("/usr/bin/swaymsg", ["swaymsg", "exit"],
            { env, cwd: "/tmp", uid: 1000, gid: 1000 });
          await ipc.exit;
          await kernel.terminateProcess(ipc.pid, 0);
        }
        const status = await root.exit;
        await kernel.terminateProcess(root.pid, 0);
        return { ...state, status, stats: Array.from(stats) };
      }, compositor);
      expect(result.status, JSON.stringify(result)).toBe(0);
      const presented = /PRESENTED sec=\d+ nsec=\d+ refresh=\d+ seq=\d+/;
      if (compositor === "cage") {
        expect(result.stdout).toMatch(presented);
      } else {
        // wlclient-test commits again when Sway configures its mapped surface.
        // That can supersede the first commit's feedback before sampling:
        // presentation-time.xml permits discarded for a superseded update.
        // Require resolved feedback plus actual GPU pixels and KMS commits.
        expect(result.stdout).toMatch(/PRESENTED sec=\d+ nsec=\d+ refresh=\d+ seq=\d+|PRESENTATION_DISCARDED/);
      }
      expect(result.stdout).toMatch(/KEYMAP format=1 size=\d+ ok=1/);
      expect(result.stderr).not.toMatch(/uname: not found|failed to execute 'swaybg'/);
      expect(result.diagnostics).toEqual([]);
      writeFileSync(`${evidenceRoot}/${evidenceName}.json`, JSON.stringify({
        engine: test.info().project.name, version: browser.version(), compositor,
        kernelSha256: hash(kernelBytes), compositorSha256: hash(program),
        clientSha256: hash(client), imageSha256: hash(image), visible, ...result,
      }, null, 2) + "\n");
    } catch (error) {
      const state = await page.evaluate(() => (globalThis as any).__portsSession?.state).catch(() => null);
      writeFileSync(`${evidenceRoot}/${evidenceName}-failure.json`, JSON.stringify({ state, errors }, null, 2) + "\n");
      throw error;
    } finally {
      await page.evaluate(async () => { await (globalThis as any).__portsSession?.kernel.destroy(); });
    }
    expect(await page.evaluate(() => (globalThis as any).__portsSession.state.diagnostics)).toEqual([]);
    expect(errors).toEqual([]);
    expect(await memoryBoundaryFailures(page)).toEqual([]);
  });
}
