import { describe, expect, it } from "vitest";
import { depthSamplingShaderSource } from "../src/webgl/depth-sampling.js";

const TEXEL = "highp vec4 kandelo_depth_texel(bool d, highp vec4 t) { return d ? vec4(t.rrr, 1.0) : t; }";

describe("depth-sampler shader rewrite", () => {
  it("wraps every texture2D* lookup of a depth sampler and leaves the others alone", () => {
    const source = "#version 100\nprecision mediump float;\nuniform sampler2D d;\nuniform sampler2D c;\nvarying vec4 q;\n" +
      "void main() {\n  gl_FragColor = texture2D(d, q.xy) + texture2DProj(d, q) + texture2D(c, q.xy, 1.0);\n}\n";
    const out = depthSamplingShaderSource(source, new Set(["d"]))!;
    const lines = out.split("\n");
    expect(lines[0]).toBe("#version 100");
    expect(lines[1]).toBe(TEXEL);
    expect(lines[2]).toBe("#line 2");
    expect(out).toContain("gl_FragColor = kandelo_depth_texel(true, texture2D(d, q.xy)) + " +
      "kandelo_depth_texel(true, texture2DProj(d, q)) + texture2D(c, q.xy, 1.0);");
  });

  it("covers the vertex-shader Lod lookups", () => {
    const source = "attribute vec4 p;\nuniform sampler2D h;\n" +
      "void main() { gl_Position = p + texture2DLod(h, p.xy, 0.0) + texture2DProjLod(h, p, 0.0); }\n";
    const out = depthSamplingShaderSource(source, new Set(["h"]))!;
    expect(out.startsWith(`${TEXEL}\n#line 1\nattribute vec4 p;`)).toBe(true);
    expect(out).toContain("kandelo_depth_texel(true, texture2DLod(h, p.xy, 0.0)) + kandelo_depth_texel(true, texture2DProjLod(h, p, 0.0))");
  });

  it("carries a flag with every sampler passed to a user function", () => {
    const source = "precision mediump float;\nuniform sampler2D d, c;\nvarying vec2 q;\n" +
      "vec4 look(sampler2D t, vec2 at);\n" +
      "vec4 look(sampler2D t, vec2 at) { return texture2D(t, at); }\n" +
      "vec4 twice(vec2 at, sampler2D s) { return look(s, at) * 2.0; }\n" +
      "void main() { gl_FragColor = look(d, q) + twice(q, c) + look(c, texture2D(d, q).xy); }\n";
    const out = depthSamplingShaderSource(source, new Set(["d"]))!;
    expect(out).toContain("vec4 look(sampler2D t, vec2 at, bool kandelo_depth_arg0);");
    expect(out).toContain("vec4 look(sampler2D t, vec2 at, bool kandelo_depth_arg0) { return kandelo_depth_texel(kandelo_depth_arg0, texture2D(t, at)); }");
    expect(out).toContain("vec4 twice(vec2 at, sampler2D s, bool kandelo_depth_arg1) { return look(s, at, kandelo_depth_arg1) * 2.0; }");
    expect(out).toContain("gl_FragColor = look(d, q, true) + twice(q, c, false) + look(c, kandelo_depth_texel(true, texture2D(d, q)).xy, false);");
  });

  it("selects sampler-array elements by index", () => {
    const source = "precision mediump float;\nuniform sampler2D s[3];\nvarying vec2 q;\n" +
      "void main() { vec4 sum = vec4(0.0); for (int i = 0; i < 3; i++) sum += texture2D(s[i], q); gl_FragColor = sum; }\n";
    const out = depthSamplingShaderSource(source, new Set(["s[1]"]))!;
    expect(out).toContain("bool kandelo_depth_s(int i) { return i == 1; }");
    expect(out).toContain("sum += kandelo_depth_texel(kandelo_depth_s(i), texture2D(s[i], q));");
  });

  it("refuses sources it cannot rewrite exactly", () => {
    const macro = "precision mediump float;\nuniform sampler2D d;\n#define LOOK(t) texture2D(t, vec2(0.0))\nvoid main() { gl_FragColor = LOOK(d); }\n";
    expect(depthSamplingShaderSource(macro, new Set(["d"]))).toBeNull();
    const member = "precision mediump float;\nstruct S { sampler2D t; };\nuniform S u;\nvoid main() { gl_FragColor = texture2D(u.t, vec2(0.0)); }\n";
    expect(depthSamplingShaderSource(member, new Set(["u.t"]))).toBeNull();
  });

});
