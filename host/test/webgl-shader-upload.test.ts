import { describe, expect, it, vi } from "vitest";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { runGlQuery } from "../src/webgl/query.js";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { installShaderSource } from "../src/webgl/shader-source.js";
import { finalizeShader } from "../src/webgl/program-objects.js";
import * as O from "../src/webgl/ops.js";

function setup() {
  const installed = new Map<object,string>(), errors: number[] = [];
  let reject = false;
  const gl = {
    getError: () => errors.shift() ?? 0,
    shaderSource: (shader: object, source: string) => { if (reject) errors.push(0x505); else installed.set(shader,source); },
    deleteShader: (shader: object) => { installed.delete(shader); },
  } as unknown as WebGL2RenderingContext;
  const reg = new GlContextRegistry();
  const [a,b] = [1,2].map(sessionId => {
    reg.bind({pid:29,sessionId,cmdbufAddr:0,cmdbufLen:1024}); const owner = reg.get(29,sessionId)!;
    owner.gl = gl; owner.contextId = sessionId; return owner;
  });
  expect(reg.shareObjects(29,2,1)).toBe(true);
  const shader = {} as WebGLShader; a.shaders.set(11,shader);
  const old = new TextEncoder().encode("old"); expect(installShaderSource(a,shader,old)).toBe(true);
  const query = (owner: typeof a, action: number, token: number, arg = 0, bytes = new Uint8Array(), name = 11) => {
    const input = new Uint8Array(16+bytes.length), out = new Uint8Array(12).fill(0xaa);
    [action,name,token,arg].forEach((value,i) => new DataView(input.buffer).setUint32(i*4,value,true)); input.set(bytes,16);
    const rc = runGlQuery(owner,O.QOP_SHADER_SOURCE_UPLOAD,input,out), v = new DataView(out.buffer);
    if (rc >= 0) expect(v.getUint32(8,true)).toBe(0x47514c33);
    return {rc,status:v.getUint32(0,true),token:v.getUint32(4,true)};
  };
  return {a,b,reg,shader,installed,query,setReject: () => { reject = true; }};
}

describe("acknowledged shader source uploads", () => {
  it("keeps partial bytes private and commits only a complete contiguous source", () => {
    const {a,b,shader,installed,query} = setup();
    const bytes = new TextEncoder().encode("large".repeat(28000));
    expect(query(a,1,1,bytes.length)).toEqual({rc:12,status:0,token:1});
    for (let offset=0; offset<bytes.length; offset+=65520) {
      expect(query(a,2,1,offset,bytes.subarray(offset,offset+65520)).status).toBe(0);
      expect(installed.get(shader)).toBe("old"); expect(new TextDecoder().decode(b.shaderSources.get(shader))).toBe("old");
    }
    expect(query(a,3,1).status).toBe(0); expect(a.shaderUpload).toBeNull();
    expect(installed.get(shader)).toBe("large".repeat(28000)); expect(a.shaderSources.get(shader)).toEqual(bytes);
  });
  it("rejects stale tokens without canceling another transaction and makes abort idempotent", () => {
    const {a,query} = setup(); query(a,1,1,100); query(a,1,2,100);
    expect(query(a,4,1).status).toBe(1); expect(a.shaderUpload?.token).toBe(2);
    expect(query(a,1,1,50).status).toBe(1); expect(a.shaderUpload?.token).toBe(2);
    expect(query(a,4,2).status).toBe(0); expect(query(a,4,2).status).toBe(0); expect(a.shaderUpload).toBeNull();
  });
  it("discards incomplete or invalid-offset uploads while preserving the previous source", () => {
    const {a,shader,installed,query} = setup();
    query(a,1,1,3); expect(query(a,2,1,1,new Uint8Array([1])).status).toBe(1); expect(a.shaderUpload).toBeNull();
    query(a,1,2,3); expect(query(a,2,2,0,new Uint8Array(4)).status).toBe(1); expect(a.shaderUpload).toBeNull();
    query(a,1,3,3); query(a,2,3,0,new Uint8Array(2)); expect(query(a,3,3).status).toBe(1);
    expect(a.shaderUpload).toBeNull(); expect(installed.get(shader)).toBe("old");
  });
  it("retires an unobserved begin token so a late request cannot recreate cancelled storage", () => {
    const {a,query} = setup(); query(a,1,1,100);
    expect(query(a,4,2).status).toBe(0); expect(a.shaderUpload).toBeNull();
    expect(query(a,1,2,100).status).toBe(1); expect(a.shaderUpload).toBeNull();
    expect(query(a,1,3,100).status).toBe(0);
    expect(query(a,4,2).status).toBe(1); expect(a.shaderUpload?.token).toBe(3);
  });
  it("keeps each context's transaction separate while source storage is shared", () => {
    const {a,b,reg,shader,installed,query} = setup(); query(a,1,1,1); query(b,1,1,1);
    query(a,2,1,0,new Uint8Array([65])); query(b,2,1,0,new Uint8Array([66]));
    query(a,3,1); expect(installed.get(shader)).toBe("A"); expect(b.shaderUpload).not.toBeNull();
    query(b,3,1); expect(installed.get(shader)).toBe("B");
    query(a,1,2,100); query(b,1,2,100); reg.destroyContext(29,1);
    expect(a.shaderUpload).toBeNull(); expect(b.shaderUpload?.bytes.length).toBe(100);
    expect(new TextDecoder().decode(b.shaderSources.get(shader))).toBe("B");
    query(b,4,2); reg.destroyContext(29,2); expect(b.shaderUpload).toBeNull();
  });
  it("preserves source after native commit rejection and drops pending storage on shader deletion", () => {
    const {a,b,shader,installed,query,setReject} = setup(); query(a,1,1,1); query(a,2,1,0,new Uint8Array([65]));
    setReject(); expect(query(a,3,1).status).toBe(1); expect(a.errors).toEqual([0x505]); expect(installed.get(shader)).toBe("old");
    expect(new TextDecoder().decode(a.shaderSources.get(shader))).toBe("old"); expect(a.shaderUpload).toBeNull();
    query(a,1,2,100); query(b,1,1,100); a.shaderDeletePending.add(11); finalizeShader(a,11);
    expect(a.shaderUpload).toBeNull(); expect(b.shaderUpload).toBeNull(); expect(a.shaders.has(11)).toBe(false);
  });
  it("releases pending storage when an ordinary inline source call replaces it", () => {
    const {a,shader,installed,query} = setup(); query(a,1,1,100);
    a.cmdbufView = new Uint8Array(15); const view = new DataView(a.cmdbufView.buffer);
    view.setUint16(0,O.OP_SHADER_SOURCE,true); view.setUint16(2,11,true);
    view.setUint32(4,11,true); view.setUint32(8,3,true); a.cmdbufView.set(new TextEncoder().encode("new"),12);
    expect(decodeAndDispatch(a,0,15)).toBe(0); expect(a.shaderUpload).toBeNull(); expect(installed.get(shader)).toBe("new");
    expect(query(a,1,1,100).status).toBe(1);
  });
  it("reports allocation failure without changing installed source or retaining an upload", () => {
    const {a,shader,installed,query} = setup(), Original = globalThis.Uint8Array;
    class LimitedArray extends Original {
      constructor(size: number) { if (size === 257) throw new RangeError("injected allocation failure"); super(size); }
    }
    vi.stubGlobal("Uint8Array",LimitedArray);
    try {
      expect(query(a,1,1,257).status).toBe(1); expect(a.shaderUpload).toBeNull();
      expect(a.errors).toEqual([0x505]); expect(installed.get(shader)).toBe("old");
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects malformed spans before touching output or pending ownership", () => {
    const {a,query} = setup(); query(a,1,1,100); const saved = a.shaderUpload;
    for (const input of [new Uint8Array(15),new Uint8Array(65537),new Uint8Array(new Uint32Array([2,11,1,0]).buffer)]) {
      const out = new Uint8Array(12).fill(0xaa); expect(runGlQuery(a,O.QOP_SHADER_SOURCE_UPLOAD,input,out)).toBe(-22);
      expect(out.every(v => v === 0xaa)).toBe(true); expect(a.shaderUpload).toBe(saved);
    }
  });
});
