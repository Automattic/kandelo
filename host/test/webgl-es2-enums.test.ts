import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";

/**
 * Guest-visible GLES 2.0.25 enum sets. The native renderer is WebGL 2, so
 * WebGL 2 and WEBGL-only names stay private to host internals: a GLES 2
 * guest must get INVALID_ENUM for them, without any native call or shadow
 * change.
 */

const INVALID_ENUM = 0x500;
type Call = [string, unknown[]];

function binding() {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(new ArrayBuffer(4096));
  const log: Call[] = [];
  const target: Record<string, unknown> = {
    getError: () => 0,
    isContextLost: () => false,
    getParameter: () => 0,
  };
  b.gl = new Proxy(target, {
    get(object, name: string) {
      if (name in object) return object[name];
      return (...args: unknown[]) => { log.push([name, args]); };
    },
  }) as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[]) => {
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true); view.setUint16(2, words.length * 4, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word, true));
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4)).toBe(0);
  };
  return { b, log, send };
}

describe("glPixelStorei (sections 3.6.1 and 4.3.1)", () => {
  it.each([
    ["PACK_ROW_LENGTH", 0x0d02], ["PACK_SKIP_ROWS", 0x0d03], ["PACK_SKIP_PIXELS", 0x0d04],
    ["UNPACK_IMAGE_HEIGHT", 0x806e], ["UNPACK_SKIP_IMAGES", 0x806d],
    // EXT_unpack_subimage state is kept by the guest encoder, never the host.
    ["UNPACK_ROW_LENGTH", 0x0cf2], ["UNPACK_SKIP_ROWS", 0x0cf3], ["UNPACK_SKIP_PIXELS", 0x0cf4],
    ["UNPACK_FLIP_Y_WEBGL", 0x9240], ["zero", 0],
  ])("rejects %s with INVALID_ENUM and keeps the host default", (_name, pname) => {
    const { b, log, send } = binding();
    const before = new Map(b.shadow.pixelStore);
    send(O.OP_PIXEL_STOREI, [pname, 3]);
    expect(b.errors).toEqual([INVALID_ENUM]);
    expect(log).toEqual([]);
    expect(b.shadow.pixelStore).toEqual(before);
  });

  it("applies the two GLES 2 alignment names", () => {
    const { b, log, send } = binding();
    send(O.OP_PIXEL_STOREI, [0x0cf5, 2]);
    send(O.OP_PIXEL_STOREI, [0x0d05, 8]);
    expect(b.errors).toEqual([]);
    expect(log).toEqual([["pixelStorei", [0x0cf5, 2]], ["pixelStorei", [0x0d05, 8]]]);
    expect([b.shadow.unpackAlignment, b.shadow.packAlignment]).toEqual([2, 8]);
  });
});
