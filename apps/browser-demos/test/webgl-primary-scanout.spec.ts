import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("primary GPU scanout is opaque while preserving source alpha and guest masks", async ({ page, baseURL, browser }) => {
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const path = fileURLToPath(new URL("../../../host/src/webgl/kms-scanout.ts", import.meta.url));
  const result = await page.evaluate(async (url) => {
    const { drawGpuScanout } = await import(/* @vite-ignore */ url);
    const canvas = document.createElement("canvas");
    canvas.id = "primary-alpha";
    canvas.width = canvas.height = 16;
    canvas.style.backgroundColor = "blue";
    document.body.replaceChildren(canvas);
    const gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true })!;
    if (!gl) throw new Error("WebGL2 is required by the primary scanout gate");
    const texture = gl.createTexture()!, fbo = gl.createFramebuffer()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("Primary scanout fixture framebuffer is incomplete");
    gl.clearColor(1, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.colorMask(true, false, true, false);
    gl.clearColor(0.25, 0.5, 0.75, 0.125);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 0, 0);
    const accepted = drawGpuScanout({ gl, fbo, w: 16, h: 16 }, 16, 16);
    const state = {
      read: gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) === fbo,
      draw: gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === fbo,
      scissor: gl.getParameter(gl.SCISSOR_TEST),
      mask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
      clear: Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE)),
    };
    const source = new Uint8Array(4), displayed = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, displayed);
    const error = gl.getError();
    (globalThis as any).__primaryAlphaGl = gl;
    return { accepted, state, source: [...source], displayed: [...displayed], error };
  }, new URL(`/@fs${path}`, baseURL).href);
  try {
    expect(result.accepted).toBe(true);
    expect(result.source).toEqual([255, 0, 0, 0]);
    expect(result.displayed).toEqual([255, 0, 0, 255]);
    expect(result.state).toEqual({ read: true, draw: true, scissor: true,
      mask: [true, false, true, false], clear: [0.25, 0.5, 0.75, 0.125] });
    expect(result.error).toBe(0);
    const root = fileURLToPath(new URL("../../../.context/graphics-primary-alpha/", import.meta.url));
    mkdirSync(root, { recursive: true });
    await page.locator("#primary-alpha").screenshot({ path: `${root}/${test.info().project.name}.png` });
    writeFileSync(`${root}/${test.info().project.name}.json`, JSON.stringify({
      version: browser.version(), ...result,
    }, null, 2) + "\n");
  } finally {
    await page.evaluate(() => (globalThis as any).__primaryAlphaGl?.getExtension("WEBGL_lose_context")?.loseContext());
  }
});
