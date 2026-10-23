import { expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { runCentralizedProgram } from "./centralized-test-helper";

it("retains imported storage through image, object, and framebuffer retirement", async () => {
  const calls: [string, unknown[]][] = [];
  let next = 0;
  const gl = new Proxy({}, {
    get(_target, key) {
      if (typeof key !== "string" || /^[A-Z0-9_]+$/.test(key)) return undefined;
      return (...args: unknown[]) => {
        calls.push([key, args]);
        if (key.startsWith("create")) return { id: ++next, kind: key };
        if (key.startsWith("get")) return 0;
        return undefined;
      };
    },
  }) as WebGL2RenderingContext;
  const result = await runCentralizedProgram({
    programPath: resolveBinary("programs/egl_image_ownership.wasm"),
    argv: ["egl_image_ownership"],
    timeout: 30_000,
    onKernelReady(kernel, pid) {
      kernel.gl.attachCanvas(pid, { getContext: () => gl } as unknown as OffscreenCanvas);
    },
  });
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stdout.trim()).toBe("OK image ownership");
  const gpuTexture = calls.find(([name, args]) =>
    name === "framebufferTexture2D" && args[0] === undefined)?.[1][3];
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
