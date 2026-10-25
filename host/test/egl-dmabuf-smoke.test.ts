import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { runCentralizedProgram } from "./centralized-test-helper";
import { loggingGraphicsGl, allocatedTexture } from "./support/logging-graphics-gl";
import { compileSdkFixture } from "./support/compile-sdk-fixture";

let fixture: ReturnType<typeof compileSdkFixture>;
beforeAll(() => {
  fixture = compileSdkFixture(new URL("../../programs/egl_dmabuf_smoke.c", import.meta.url),
    ["-lEGL", "-lGLESv2", "-lgbm", "-ldrm"]);
}, 120_000);
afterAll(() => fixture?.cleanup());

const GL_TEXTURE_2D = 0x0de1;
const GL_UNSIGNED_BYTE = 0x1401;
const GL_RGBA = 0x1908;
const GL_UNPACK_ROW_LENGTH = 0x0cf2;
const GL_UNPACK_SKIP_ROWS = 0x0cf3;
const GL_UNPACK_SKIP_PIXELS = 0x0cf4;
const GL_COLOR_ATTACHMENT0 = 0x8ce0;
const GL_FRAMEBUFFER = 0x8d40;

type GlCall = [string, unknown[]];

function makeFakeCanvas(gl: WebGL2RenderingContext) {
  return {
    getContext(kind: string) {
      return kind === "webgl2" ? gl : null;
    },
  } as unknown as OffscreenCanvas;
}

function rgbaFromBgrx(
  rows: number,
  columns: number,
  byte: (row: number, column: number, channel: number) => number,
): number[] {
  const out: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      out.push(byte(r, c, 2), byte(r, c, 1), byte(r, c, 0), byte(r, c, 3));
    }
  }
  return out;
}

describe("EGL dma-buf import over the GLES stubs", () => {
  it(
    "validates dma-buf planes and forwards EGLImage and unpack uploads to WebGL",
    async () => {
      const { calls: log, gl } = loggingGraphicsGl();
      const result = await runCentralizedProgram({
        programPath: fixture.programPath,
        argv: ["egl_dmabuf_smoke"],
        timeout: 30_000,
        onKernelReady: (kernel, pid) => kernel.gl.attachCanvas(pid, makeFakeCanvas(gl)),
      });
      expect(
        result.exitCode,
        `stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.stdout.trim()).toBe("OK");
      expect(result.stderr).not.toContain("FAIL:");

      const at = (name: string, args: unknown[]) =>
        log.findIndex(([n, a]) => n === name && isDeepStrictEqual(a, args));
      const calls = (name: string) =>
        log.filter(([n]) => n === name).map(([, a]) => a);

      const imageAllocation = at("texImage2D", [
        GL_TEXTURE_2D, 0, GL_RGBA, 3, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, null,
      ]);
      const imageUpload = at("texSubImage2D", [
        GL_TEXTURE_2D, 0, 0, 0, 3, 2, GL_RGBA, GL_UNSIGNED_BYTE,
        rgbaFromBgrx(2, 3, (y, x, c) => y * 16 + x * 4 + c + 1),
      ]);
      expect(imageAllocation).toBeGreaterThan(-1);
      expect(imageUpload).toBeGreaterThan(imageAllocation);

      const unpackAllocation = at("texImage2D", [
        GL_TEXTURE_2D, 0, GL_RGBA, 2, 2, 0, GL_RGBA, GL_UNSIGNED_BYTE, null,
      ]);
      const unpackUpload = at("texSubImage2D", [
        GL_TEXTURE_2D, 0, 0, 0, 2, 2, GL_RGBA, GL_UNSIGNED_BYTE,
        rgbaFromBgrx(2, 2, (y, x, c) => 0x40 + (y + 1) * 16 + (x + 1) * 4 + c),
      ]);
      expect(unpackAllocation).toBeGreaterThan(-1);
      expect(unpackUpload).toBeGreaterThan(unpackAllocation);
      // The CPU shim already repacks these rows. Native state restoration
      // may explicitly reset WebGL2's fields, but must not apply the guest's
      // nonzero row/skip values a second time to the repacked upload.
      expect(calls("pixelStorei").filter(([pname, value]) =>
        [GL_UNPACK_ROW_LENGTH, GL_UNPACK_SKIP_ROWS, GL_UNPACK_SKIP_PIXELS].includes(Number(pname))
          && value !== 0)).toEqual([]);

      const matrices = calls("uniformMatrix3fv");
      expect(matrices).toHaveLength(1);
      expect(matrices[0][0]).toBeInstanceOf(Object);
      expect(matrices[0].slice(1)).toEqual([false, [1, 2, 3, 4, 5, 6, 7, 8, 9]]);

      const attachments = calls("framebufferTexture2D");
      const gpuBoTexture = allocatedTexture(log, 64, 64);
      const guestAttachment = attachments.findLast(([target, point, textureTarget, texture]) =>
        target === GL_FRAMEBUFFER && point === GL_COLOR_ATTACHMENT0
        && textureTarget === GL_TEXTURE_2D && texture === gpuBoTexture);
      expect(gpuBoTexture).toBeInstanceOf(Object);
      expect(attachments.filter(([, , , texture]) => texture === gpuBoTexture).length).toBeGreaterThanOrEqual(2);
      expect(guestAttachment?.slice(0, 3)).toEqual([
        GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D,
      ]);
      expect(guestAttachment?.[3]).toBe(gpuBoTexture);
      expect(guestAttachment?.[4]).toBe(0);
      expect(
        calls("framebufferRenderbuffer").filter(([target, point]) =>
          target === GL_FRAMEBUFFER && point === GL_COLOR_ATTACHMENT0),
      ).toHaveLength(0);
    },
  );
});
