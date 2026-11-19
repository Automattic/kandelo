/**
 * A client of sway names its pointer's cursor, and the cursor plane shows
 * it: the `pointer` shape of wp_cursor_shape_v1, no image after a
 * wl_pointer.set_cursor without a surface, and sway's default cursor once
 * the pointer has left the window. The rootfs holds no cursor theme, so the
 * images are the ones wlroots carries.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";
import type { Page } from "../playwright-test";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { compositorBytes, sessionRootfs } from "../../../host/test/wlroots-session";

test.use({ serviceWorkers: "block", viewport: { width: 800, height: 600 } });

const WIDTH = 640;
const HEIGHT = 480;
const GAP = 100;
// wlclient-test keeps a 200x150 surface at the top left of its tile.
const INSIDE = GAP + 50;

const bytes = (name: string) => new Uint8Array(readFileSync(resolveBinary(name)));
const text = (value: string) => new TextEncoder().encode(value);

const FONTS_CONF = '<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig>' +
  "<dir>/usr/share/fonts</dir><cachedir>/tmp/fontconfig</cachedir>" +
  "<alias><family>monospace</family><prefer><family>Inconsolata</family></prefer></alias></fontconfig>";

const stdout = (page: Page) => page.evaluate(() => (globalThis as any).__cursorSession.state.stdout as string);

/** The cursor plane's opaque pixels: how many, and the image inside their
 *  bounding box, which does not change with the pointer's position. */
const cursorImage = (page: Page) => page.evaluate(() => {
  const plane = document.querySelector<HTMLCanvasElement>("#cursor-plane")!;
  const copy = new OffscreenCanvas(plane.width, plane.height).getContext("2d")!;
  copy.drawImage(plane, 0, 0);
  const { data, width, height } = copy.getImageData(0, 0, plane.width, plane.height);
  let count = 0, left = width, top = height, right = -1, bottom = -1;
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] === 0) continue;
    const x = i % width, y = Math.floor(i / width);
    count++;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (count === 0) return { count, image: "" };
  const box = copy.getImageData(left, top, right - left + 1, bottom - top + 1);
  return { count, image: `${box.width}x${box.height}:${Array.from(box.data).join(",")}` };
});

async function movePointer(page: Page, x: number, y: number) {
  await page.evaluate(({ x, y }) => {
    const { kernel } = (globalThis as any).__cursorSession;
    kernel.injectInputEvent(1, 3, 0, x); kernel.injectInputEvent(1, 3, 1, y);
    kernel.injectInputEvent(1, 0, 0, 0);
  }, { x, y });
}

async function pressButton(page: Page, state: number) {
  await page.evaluate((state) => {
    const { kernel } = (globalThis as any).__cursorSession;
    kernel.injectInputEvent(1, 1, 0x110, state); kernel.injectInputEvent(1, 0, 0, 0);
  }, state);
}

test("sway shows the cursor a client names on the cursor plane", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const image = await sessionRootfs("sway", [
    { path: "/usr/bin/sway", bytes: new Uint8Array(compositorBytes("sway")), mode: 0o755 },
    { path: "/usr/bin/wlclient-test", bytes: bytes("programs/wlclient-test.wasm"), mode: 0o755 },
    { path: "/bin/sh", bytes: bytes("programs/dash.wasm"), mode: 0o755 },
    { path: "/usr/bin/swaymsg", bytes: bytes("programs/sway/swaymsg.wasm"), mode: 0o755 },
    { path: "/usr/share/fonts/Inconsolata-Regular.ttf", bytes: new Uint8Array(readFileSync(
      new URL("../../../third_party/Inconsolata-Regular.ttf", import.meta.url))), mode: 0o644 },
    { path: "/etc/fonts/fonts.conf", bytes: text(FONTS_CONF), mode: 0o644 },
    { path: "/etc/sway/config", bytes: text(
      `font pango:monospace 10\ndefault_border none\ngaps outer ${GAP}\nexec /usr/bin/wlclient-test\n`), mode: 0o644 },
  ]);
  const kernelBytes = bytes("kernel.wasm");
  await page.route("**/__cursor_kernel", route => route.fulfill({ body: Buffer.from(kernelBytes) }));
  await page.route("**/__cursor_image", route => route.fulfill({ body: Buffer.from(image) }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const modulePath = fileURLToPath(new URL("../../../host/src/browser-kernel-host.ts", import.meta.url));
  try {
    await page.evaluate(async ({ url, width, height }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ url);
      const state = { stdout: "", stderr: "", diagnostics: [] as unknown[] };
      const kernel = new BrowserKernel({ kernelOwnedFs: true,
        onStdout: (data: Uint8Array) => { state.stdout += new TextDecoder().decode(data); },
        onStderr: (data: Uint8Array) => { state.stderr += new TextDecoder().decode(data); },
        onHostDiagnostic: (value: unknown) => state.diagnostics.push(value),
      });
      (globalThis as any).__cursorSession = { kernel, state };
      await kernel.initFromImage({
        kernelWasm: await (await fetch("/__cursor_kernel")).arrayBuffer(),
        vfsImage: new Uint8Array(await (await fetch("/__cursor_image")).arrayBuffer()),
      });
      const scene = document.createElement("canvas"), cursor = document.createElement("canvas");
      cursor.id = "cursor-plane";
      scene.width = cursor.width = width; scene.height = cursor.height = height;
      const display = document.createElement("div");
      display.style.cssText = `position:relative;width:${width}px;height:${height}px;background:black`;
      for (const plane of [scene, cursor]) {
        plane.style.cssText = "position:absolute;left:0;top:0";
        display.appendChild(plane);
      }
      document.body.replaceChildren(display);
      const stats = new Int32Array(new SharedArrayBuffer(36));
      kernel.setInputCanvasDims(width, height);
      kernel.kmsSetDisplaySize(1, width, height);
      kernel.kmsAttachCanvas(1, scene.transferControlToOffscreen(), stats.buffer, {
        mode: "webgl2-scanout", cursorCanvas: cursor.transferControlToOffscreen(),
      });
      const env = ["LIBSEAT_BACKEND=noop", "WLR_RENDERER=gles2", "XDG_RUNTIME_DIR=/tmp",
        "PATH=/usr/bin:/bin", "HOME=/tmp", "SWAYSOCK=/tmp/sway-ipc.sock", "WLC_CURSOR=1"];
      const root = await kernel.spawnFromVfs("/usr/bin/sway", ["sway"],
        { env, cwd: "/tmp", uid: 1000, gid: 1000 });
      Object.assign((globalThis as any).__cursorSession, { root, env });
    }, { url: new URL(`/@fs${modulePath}`, baseURL).href, width: WIDTH, height: HEIGHT });
    await expect.poll(() => stdout(page), { timeout: 90_000 }).toContain("CLIENT_READY\n");

    await movePointer(page, INSIDE, INSIDE);
    await expect.poll(() => stdout(page), { timeout: 30_000 }).toContain("CURSOR_SHAPE_SET\n");
    await expect.poll(async () => (await cursorImage(page)).count, { timeout: 30_000 }).toBeGreaterThan(0);
    // The default cursor may still be up when the client's marker arrives.
    await page.waitForTimeout(1_000);
    const named = await cursorImage(page);
    expect(named.count).toBeGreaterThan(0);

    await pressButton(page, 1);
    await expect.poll(() => stdout(page), { timeout: 30_000 }).toContain("CURSOR_HIDDEN_SET\n");
    await expect.poll(async () => (await cursorImage(page)).count, { timeout: 30_000 }).toBe(0);

    // A held button keeps the pointer on the window that took the press.
    await pressButton(page, 0);
    await movePointer(page, GAP / 2, GAP / 2);
    await expect.poll(() => stdout(page), { timeout: 30_000 }).toContain("CURSOR_SHAPE_OK\n");
    await expect.poll(async () => (await cursorImage(page)).count, { timeout: 30_000 }).toBeGreaterThan(0);
    expect((await cursorImage(page)).image).not.toBe(named.image);

    const result = await page.evaluate(async () => {
      const { kernel, root, env, state } = (globalThis as any).__cursorSession;
      const ipc = await kernel.spawnFromVfs("/usr/bin/swaymsg", ["swaymsg", "exit"],
        { env, cwd: "/tmp", uid: 1000, gid: 1000 });
      await ipc.exit;
      await kernel.terminateProcess(ipc.pid, 0);
      const status = await root.exit;
      await kernel.terminateProcess(root.pid, 0);
      return { ...state, status };
    });
    expect(result.status, JSON.stringify(result)).toBe(0);
    expect(result.diagnostics).toEqual([]);
  } finally {
    await page.evaluate(async () => { await (globalThis as any).__cursorSession?.kernel.destroy(); });
  }
  expect(errors).toEqual([]);
});
