import { expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { loggingGraphicsGl, allocatedTexture } from "./support/logging-graphics-gl";
import { runCentralizedProgram } from "./centralized-test-helper";

const programPath = resolveBinary("programs/egl_image_ownership.wasm");

it("retains imported storage through image, object, and framebuffer retirement", async () => {
  const { calls, gl } = loggingGraphicsGl();
  const result = await runCentralizedProgram({
    programPath,
    argv: ["egl_image_ownership"],
    timeout: 30_000,
    onKernelReady(kernel, pid) {
      kernel.gl.attachCanvas(pid, { getContext: () => gl } as unknown as OffscreenCanvas);
    },
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe("OK image ownership");
  const gpuTexture = allocatedTexture(calls, 64, 64);
  expect(calls.some(([name, args]) => name === "framebufferTexture2D"
    && args[0] === 0x8d40 && args[3] === gpuTexture)).toBe(true);
  expect(gpuTexture).toBeInstanceOf(Object);
  const markers = [0.125, 0.25, 0.375, 0.5, 0.625].map(value =>
    calls.findIndex(([name, args]) => name === "clearColor" && args[0] === value));
  expect(markers.every((index, i) => index >= 0 && (!i || index > markers[i - 1]))).toBe(true);
  const retirement = calls.flatMap(([name, args], index) =>
    name === "deleteTexture" && args[0] === gpuTexture ? [index] : []);
  expect(retirement).toHaveLength(1);
  expect(retirement[0]).toBeGreaterThan(markers[3]);
  expect(retirement[0]).toBeLessThan(markers[4]);
  let texture: unknown;
  let redefined: unknown;
  for (const [name, args] of calls) {
    if (name === "bindTexture" && args[0] === 0x0de1) texture = args[1];
    if (name === "texImage2D" && args[3] === 2 && args[4] === 2) redefined = texture;
  }
  expect(redefined).toBeInstanceOf(Object);
  expect(redefined).not.toBe(gpuTexture);
}, 60_000);
