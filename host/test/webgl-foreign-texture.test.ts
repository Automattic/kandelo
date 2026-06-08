import { describe, expect, it } from "vitest";
import { ForeignTextureRegistry } from "../src/webgl/registry.js";

class FakeGl {
  TEXTURE_2D = 0x0de1;
  RGBA = 0x1908;
  UNSIGNED_BYTE = 0x1401;

  created = 0;
  deleted: object[] = [];
  texImage2DArgs: unknown[][] = [];

  createTexture(): object { return { id: ++this.created }; }
  bindTexture(_t: number, _tex: object): void {}
  texImage2D(...a: unknown[]): void { this.texImage2DArgs.push(a); }
  deleteTexture(t: object): void { this.deleted.push(t); }
}

const asGl = (g: FakeGl) => g as unknown as WebGL2RenderingContext;

describe("ForeignTextureRegistry", () => {
  it("allocate creates one texture sized w×h", () => {
    const reg = new ForeignTextureRegistry();
    const gl = new FakeGl();
    reg.allocate(42, 64, 32, asGl(gl));
    expect(gl.created).toBe(1);
    const [, , , w, h] = gl.texImage2DArgs[0];
    expect(w).toBe(64);
    expect(h).toBe(32);
  });

  it("bind on unknown bo returns -1", () => {
    const reg = new ForeignTextureRegistry();
    expect(reg.bind(99, 1)).toBe(-1);
  });

  it("two ctx_ids resolve back to the same WebGLTexture", () => {
    const reg = new ForeignTextureRegistry();
    const gl = new FakeGl();
    reg.allocate(7, 16, 16, asGl(gl));
    const id_a = reg.bind(7, 100);
    const id_b = reg.bind(7, 200);
    expect(id_a).toBeGreaterThan(0);
    expect(id_b).toBeGreaterThan(0);
    expect(gl.created).toBe(1);
    expect(reg.resolve(100, id_a)).toBe(reg.resolve(200, id_b));
  });

  it("synthetic ids are independent per ctx_id", () => {
    const reg = new ForeignTextureRegistry();
    const gl = new FakeGl();
    reg.allocate(1, 4, 4, asGl(gl));
    reg.allocate(2, 4, 4, asGl(gl));
    expect(reg.bind(1, 50)).toBe(1);
    expect(reg.bind(2, 50)).toBe(2);
    expect(reg.bind(1, 51)).toBe(1);
  });

  it("free deletes the texture and drops the entry", () => {
    const reg = new ForeignTextureRegistry();
    const gl = new FakeGl();
    reg.allocate(5, 8, 8, asGl(gl));
    reg.free(5, asGl(gl));
    expect(gl.deleted.length).toBe(1);
    expect(reg.bind(5, 1)).toBe(-1);
  });
});
