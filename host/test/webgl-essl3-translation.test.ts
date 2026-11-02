import { describe, expect, it } from "vitest";
import { decodeAndDispatch } from "../src/webgl/bridge.js";
import { runGlQuery } from "../src/webgl/query.js";
import * as O from "../src/webgl/ops.js";
import { GlContextRegistry } from "../src/webgl/registry.js";
import { preprocessEssl100 } from "../src/webgl/essl-preprocessor.js";
import {
  compileGuestShader, derivativeValidationSource, guestInterfaceName, nativeInterfaceName, onlyAppendixALimitations,
  prepareLinkLanguages, recordShaderLanguage, standardDerivativesShaderSource, translateEssl100,
} from "../src/webgl/essl3-translation.js";

/**
 * GLSL ES 1.00 shaders that WebGL rejects only for Appendix A, compiled as
 * ESSL 3.00 (essl3-translation.ts). The text checks here pin the
 * translation's decisions; tests/graphics/shader-rewrite-check and
 * tests/graphics/essl3-translation-check compile and draw them with real
 * engines.
 */

const code = (source: string) => preprocessEssl100(source).tokens.map(t => t.text).join(" ");
/** The translated source's code lines, without the header. */
const body = (text: string) => text.slice(text.indexOf("#line"));

describe("ES 1.00 preprocessor (accepted input)", () => {
  it("expands object-like and function-like macros, rescanning without self-recursion", () => {
    expect(code("#define A B + 1\n#define B A\nint x = A;")).toBe("int x = A + 1 ;");
    expect(code("#define F(a, b) ((a) * (b))\n#define G F\nfloat y = G(1.0, F(2.0, 3.0));"))
      .toBe("float y = ( ( 1.0 ) * ( ( ( 2.0 ) * ( 3.0 ) ) ) ) ;");
    // A function-like macro name without "(" is not an invocation; its
    // arguments may span lines.
    expect(code("#define F(x) x\nint F;\nint y = F(\n1\n);")).toBe("int F ; int y = 1 ;");
    expect(code("#define F (x) x\nint F;")).toBe("int ( x ) x ;");
  });

  it("evaluates conditionals with defined, short-circuits and nested inactive groups", () => {
    const source = "#define ONE 1\n#if defined(ONE) && ONE == 1 && (3 % 2) && !defined TWO\nyes\n#elif 1\nno\n#else\nno\n#endif\n" +
      "#ifdef TWO\nno\n#if 1\nno\n#else\nno\n#endif\n#else\nyes2\n#endif\n#if 0 || UNDEFINED\nno\n#endif\n#ifndef ONE\nno\n#endif";
    expect(code(source)).toBe("yes yes2");
  });

  it("predefines GL_ES, __VERSION__ 100 and GL_FRAGMENT_PRECISION_HIGH, and numbers lines as ANGLE does", () => {
    expect(code("int a = GL_ES + __VERSION__ + GL_FRAGMENT_PRECISION_HIGH;")).toBe("int a = 1 + 100 + 1 ;");
    const lines = preprocessEssl100("a\n\nb __LINE__\n#line 40\nc __LINE__\n#define L __LINE__\nd L \\\n e __LINE__ __FILE__").tokens;
    expect(lines.map(t => `${t.text}@${t.line}`)).toEqual(["a@1", "b@3", "3@3", "c@40", "40@40", "d@42", "42@42", "e@43", "43@43", "0@43"]);
  });

  it("treats comments as whitespace and keeps directives in order", () => {
    const { tokens, directives } = preprocessEssl100("/* a\n b */ x // y\n#pragma optimize(off)\n#extension all : warn\nz");
    expect(tokens.map(t => `${t.text}@${t.line}`)).toEqual(["x@2", "z@5"]);
    expect(directives.map(d => [d.kind, d.tokens.join(" "), d.at])).toEqual([["pragma", "optimize ( off )", 1], ["extension", "all : warn", 1]]);
    // ESSL has no hex floats: 0xe+1 is three tokens; 1e+1 is one.
    expect(code("int a = 0xe+1; float b = 1e+1;")).toBe("int a = 0xe + 1 ; float b = 1e+1 ;");
  });
});

describe("ESSL 3.00 translation", () => {
  it("puts #version 300 es first and keeps every guest line number", () => {
    const source = "// comment\n#version 100\nattribute vec4 p;\nvarying vec2 v;\n\nvoid main() {\n  v = p.xy;\n  gl_Position = p;\n}\n";
    const { text } = translateEssl100(source, false);
    expect(text.startsWith("#version 300 es\n")).toBe(true);
    expect(body(text)).toBe("#line 3\nin vec4 p ;\nout vec2 v ;\n\nvoid main ( ) {\nv = p . xy ;\ngl_Position = p ;\n}\n");
  });

  it("declares the fragment outputs and maps the ES 1.00 lookups by stage", () => {
    const fragment = translateEssl100("precision mediump float;\nvarying vec2 v;\nuniform sampler2D s;\nuniform samplerCube c;\n" +
      "void main() { gl_FragColor = texture2D(s, v) + texture2DProj(s, vec3(v, 1.0), 0.5) + textureCube(c, vec3(v, 1.0)); }\n", true).text;
    expect(fragment).toContain("layout(location = 0) out mediump vec4 kandelo_essl3_FragColor;");
    // A cube map is sampled per face from its 2D array storage (cube-storage.ts).
    expect(fragment).toContain("kandelo_essl3_FragColor = texture ( s , v ) + textureProj ( s , vec3 ( v , 1.0 ) , 0.5 ) + kandelo_essl3_textureCube ( c ,");
    expect(fragment).toContain("uniform sampler2DArray c ;");
    expect(fragment).toContain("in vec2 v ;");
    const data = translateEssl100("precision mediump float;\nvoid main() { gl_FragData[0] = vec4(1.0); }\n", true).text;
    expect(data).toContain("layout(location = 0) out mediump vec4 kandelo_essl3_FragData[1];");
    expect(data).not.toContain("kandelo_essl3_FragColor");
    const vertex = translateEssl100("uniform sampler2D s;\nattribute vec4 p;\nvoid main() { gl_Position = texture2DLod(s, p.xy, 0.0) + texture2DProjLod(s, p, 1.0); }\n", false).text;
    expect(vertex).toContain("textureLod ( s , p . xy , 0.0 ) + textureProjLod ( s , p , 1.0 )");
    // A fragment shader may define its own texture2DLod: ES 1.00 has none there.
    const own = translateEssl100("precision mediump float;\nuniform sampler2D s;\nvec4 texture2DLod(sampler2D t, vec2 c, float l) { return texture2D(t, c); }\n" +
      "void main() { gl_FragColor = texture2DLod(s, vec2(0.0), 1.0); }\n", true).text;
    expect(own).toContain("vec4 texture2DLod ( sampler2D t");
    expect(own).toContain("= texture2DLod ( s ,");
  });

  it("reports using both gl_FragColor and gl_FragData as ANGLE does for ES 1.00", () => {
    const result = translateEssl100("precision mediump float;\nvoid main() {\n gl_FragColor = vec4(1.0);\n gl_FragData[0] = vec4(1.0);\n}\n", true);
    expect(result.error).toBe("cannot use both gl_FragData and gl_FragColor");
    expect(result.text).toBe("#version 300 es\n#line 3\n#error cannot use both gl_FragData and gl_FragColor\n");
    // Static use is after preprocessing: an inactive or unused mention is none.
    expect(translateEssl100("precision mediump float;\n#define UNUSED gl_FragData[0]\n#if 0\ngl_FragData[0] = vec4(0.0);\n#endif\n" +
      "void main() { gl_FragColor = vec4(1.0); }\n", true).error).toBeUndefined();
  });

  it("renames identifiers ESSL 3.00 reserves, injectively, at every use", () => {
    const { text } = translateEssl100("precision mediump float;\nuniform float sample;\nstruct S { float filter; };\nuniform S active;\n" +
      "float kandelo_essl1_texture;\nfloat round(float x) { return x; }\n" +
      "#define T texture\nvoid main() { float T = sample + active.filter + round(1.0) + kandelo_essl1_texture; gl_FragColor = vec4(T); }\n", true);
    for (const name of ["sample", "filter", "active", "round", "texture"]) expect(text).toContain(`kandelo_essl1_${name}`);
    expect(text).toContain("kandelo_essl1_kandelo_essl1_texture");
    expect(text).not.toMatch(/(?<!kandelo_essl1_)\b(sample|round)\b/);
  });

  it("maps interface names both ways, injectively", () => {
    for (const [guest, native] of [["sample", "kandelo_essl1_sample"], ["light.filter[2].x", "light.kandelo_essl1_filter[2].x"],
      ["color", "color"], ["kandelo_essl1_sample", "kandelo_essl1_kandelo_essl1_sample"], ["kandelo_esslx", "kandelo_essl1_kandelo_esslx"],
      ["texture[0]", "kandelo_essl1_texture[0]"]]) {
      expect(nativeInterfaceName(guest)).toBe(native);
      expect(guestInterfaceName(native)).toBe(guest);
    }
  });

  it("forwards built-ins a guest overloads, except in constant expressions", () => {
    const { text } = translateEssl100("precision mediump float;\nfloat max(int a, int b) { return 1.0; }\nconst float k = max(1.0, 2.0);\n" +
      "float a[int(max(2.0, 3.0))];\nvoid main() { gl_FragColor = vec4(max(1, 2) + max(k, 1.0)); }\n", true);
    expect(text).toContain("highp float kandelo_essl1_max(highp float p0, highp float p1) { return max(p0, p1); }");
    expect(text).toContain("highp vec4 kandelo_essl1_max(highp vec4 p0, highp float p1) { return max(p0, p1); }");
    expect(text).toContain("float kandelo_essl1_max ( int a , int b )");
    expect(text).toContain("const float k = max ( 1.0 , 2.0 ) ;");
    expect(text).toContain("float a [ int ( max ( 2.0 , 3.0 ) ) ] ;");
    expect(text).toContain("vec4 ( kandelo_essl1_max ( 1 , 2 ) + kandelo_essl1_max ( k , 1.0 ) )");
    // texture2D forwarders call the ESSL 3.00 lookup, with a bias in the
    // fragment stage only.
    const lookups = translateEssl100("vec4 texture2D(float x) { return vec4(x); }\nvoid main() { gl_Position = texture2D(1.0); }\n", false).text;
    expect(lookups).toContain("highp vec4 kandelo_essl1_texture2D(sampler2D p0, highp vec2 p1) { return texture(p0, p1); }");
    expect(lookups).not.toContain("highp float p2) { return texture(");
  });

  it("runs non-constant global initializers at the start of main", () => {
    const { text } = translateEssl100("uniform float u;\nconst float c = 2.0;\nfloat a = c, b = u * c;\nfloat d = 1.0;\n" +
      "attribute vec4 p;\nvoid main() { gl_Position = p * b; }\n", false);
    expect(text).toContain("float a = c , b ;");
    expect(text).toContain("float d = 1.0 ;");
    expect(text).toContain("void kandelo_essl3_main ( )");
    expect(text).toContain("void main() { b = u * c; kandelo_essl3_main(); }");
    expect(translateEssl100("float g = 1.0;\nvoid main() { gl_Position = vec4(g); }\n", false).text).not.toContain("kandelo_essl3_main");
  });

  it("drops fragment invariance and encodes varying invariance in names", () => {
    const vertex = translateEssl100("invariant varying vec4 a;\nvarying vec4 b;\ninvariant b;\nvoid main() { a = b = vec4(0.0); gl_Position = a.xyzw; }\n", false).text;
    expect(vertex).toContain("invariant out vec4 kandelo_essl3_invariant_a ;");
    expect(vertex).toContain("invariant kandelo_essl3_invariant_b ;");
    expect(vertex).toContain("kandelo_essl3_invariant_a . xyzw");
    const fragment = translateEssl100("#pragma STDGL invariant(all)\nprecision mediump float;\ninvariant varying vec4 a;\nvarying vec4 b;\n" +
      "invariant gl_FragCoord;\nvoid main() { gl_FragColor = a + b; }\n", true).text;
    expect(fragment).not.toMatch(/invariant (in|gl_|\()/);
    expect(fragment).toContain("in vec4 kandelo_essl3_invariant_a ;");
    expect(fragment).toContain("in vec4 b ;");
    // A vertex shader's invariant(all) makes every varying invariant.
    expect(translateEssl100("#pragma STDGL invariant(all)\nvarying vec4 b;\nvoid main() { b = vec4(0.0); gl_Position = b; }\n", false).text)
      .toMatch(/^#version 300 es\n#pragma STDGL invariant\(all\)\n[^]*out vec4 kandelo_essl3_invariant_b ;/);
  });

  it("defines the standard derivatives forwarders only where they are named", () => {
    const source = standardDerivativesShaderSource("#extension GL_OES_standard_derivatives : enable\nprecision mediump float;\n" +
      "void main() { gl_FragColor = vec4(fwidth(1.0)); }\n");
    const { text } = translateEssl100(source, true);
    expect(text).toContain("highp vec2 kandelo_oes_fwidth_builtin(highp vec2 p) { return fwidth(p); }");
    expect(text).not.toContain("kandelo_oes_dFdx_builtin(");
    expect(text).toContain("kandelo_essl3_FragColor = vec4 ( kandelo_oes_fwidth_builtin ( 1.0 ) )");
  });
});

describe("GL_OES_standard_derivatives on ES 1.00 sources", () => {
  it("makes the functions exist where the extension is enabled, on the directive's line", () => {
    const source = "#extension GL_OES_standard_derivatives : enable\nprecision mediump float;\n" +
      "#ifdef GL_OES_standard_derivatives\nfloat w = dFdx(1.0);\n#endif\n";
    const text = standardDerivativesShaderSource(source);
    expect(text).toContain("#define kandelo_GL_OES_standard_derivatives 1\n");
    expect(text).toContain("#ifdef kandelo_GL_OES_standard_derivatives\nfloat w = kandelo_oes_dFdx(1.0);");
    expect(text).toContain("#undef kandelo_oes_dFdx\n#define kandelo_oes_dFdx kandelo_oes_dFdx_builtin\n");
    // The guest's line 4 is still line 4.
    expect(preprocessEssl100(text).tokens.find(t => t.text === "w")!.line).toBe(4);
    expect(code(text)).toContain("w = kandelo_oes_dFdx_builtin ( 1.0 )");
    // Not enabled (or disabled): the guest's own identifiers.
    expect(code(standardDerivativesShaderSource("float dFdx(float x) { return x; }\nfloat y = dFdx(1.0);\n")))
      .toBe("float dFdx ( float x ) { return x ; } float y = dFdx ( 1.0 ) ;");
    expect(code(standardDerivativesShaderSource("#extension GL_OES_standard_derivatives : disable\nfloat y = dFdx(1.0);\n")))
      .toBe("float y = dFdx ( 1.0 ) ;");
    // A guest #define of the reserved name stays for the engine to reject.
    expect(standardDerivativesShaderSource("#define GL_OES_standard_derivatives 1\nint dFdy;\n")).toContain("#define GL_OES_standard_derivatives 1\n");
    expect(standardDerivativesShaderSource("void main() {}\n")).toBe("void main() {}\n");
  });

  it("declares the built-ins' signatures for the ES 1.00 validity compile", () => {
    const source = standardDerivativesShaderSource("#extension GL_OES_standard_derivatives : require\nprecision mediump float;\n");
    expect(derivativeValidationSource(source, true)).toContain("highp vec3 kandelo_oes_dFdy_builtin(highp vec3 p) { return p; }");
    expect(derivativeValidationSource(source, false)).toContain("#define kandelo_oes_dFdx_builtin dFdx");
    expect(derivativeValidationSource(standardDerivativesShaderSource("float dFdx;\n"), true)).toBeNull();
  });
});

describe("which compiles are translated", () => {
  it("recognizes logs whose every error is an Appendix A limitation", () => {
    expect(onlyAppendixALimitations("ERROR: 0:3: 'while' : This type of loop is not allowed\n")).toBe(true);
    expect(onlyAppendixALimitations("ERROR: 0:3: 'i' : Loop index cannot be compared with non-constant expression\n" +
      "ERROR: 0:9: 'k' : Index expression can only contain const or loop symbols\nWARNING: 0:1: 'x' : unused\n")).toBe(true);
    expect(onlyAppendixALimitations("ERROR: 0:3: 'while' : This type of loop is not allowed\nERROR: 0:4: 'x' : undeclared identifier\n")).toBe(false);
    expect(onlyAppendixALimitations("WARNING: 0:1: 'x' : something\n")).toBe(false);
    expect(onlyAppendixALimitations("")).toBe(false);
  });
});

// --- the host path ------------------------------------------------------------

type Shader = { type: number; source: string; compiled: boolean; log: string; compiles: number };
type Program = { shaders: Shader[]; bindings: Map<string, number>; linked: boolean; uniforms: string[]; attributes: string[] };

/** An ANGLE-like front end: ES 1.00 sources with a `while` loop fail with
 * the Appendix A message, `BROKEN` is any other error, and ESSL 3.00
 * accepts both. Linking requires one language version. */
class TranslationGl {
  error = 0;
  current: Program | null = null;
  getError() { const error = this.error; this.error = 0; return error; }
  isContextLost() { return false; }
  getExtension() { return null; }
  getParameter() { return 0; }
  createShader(type: number): Shader { return { type, source: "", compiled: false, log: "", compiles: 0 }; }
  deleteShader() {}
  shaderSource(shader: Shader, source: string) { shader.source = source; }
  compileShader(shader: Shader) {
    shader.compiles++;
    const essl300 = shader.source.startsWith("#version 300 es");
    const errors = [];
    if (shader.source.includes("BROKEN")) errors.push("ERROR: 0:1: 'BROKEN' : undeclared identifier");
    if (!essl300 && /\bwhile\b/.test(shader.source)) errors.push("ERROR: 0:2: 'while' : This type of loop is not allowed");
    if (essl300 && shader.source.includes("#error")) errors.push("ERROR: 0:1: '#error' : translation");
    shader.compiled = !errors.length;
    shader.log = errors.join("\n");
  }
  getShaderParameter(shader: Shader, pname: number) { return pname === 0x8b4f ? shader.type : shader.compiled; }
  getShaderInfoLog(shader: Shader) { return shader.log; }
  createProgram(): Program { return { shaders: [], bindings: new Map(), linked: false, uniforms: [], attributes: [] }; }
  deleteProgram() {}
  attachShader(program: Program, shader: Shader) { program.shaders.push(shader); }
  bindAttribLocation(program: Program, index: number, name: string) { program.bindings.set(name, index); }
  linkProgram(program: Program) {
    const versions = new Set(program.shaders.map(shader => shader.source.startsWith("#version 300 es")));
    program.linked = program.shaders.every(shader => shader.compiled) && versions.size === 1;
    const names = (pattern: RegExp) => [...new Set(program.shaders.flatMap(shader => [...shader.source.matchAll(pattern)].map(m => m[1])))];
    program.uniforms = names(/\buniform (?:\w+p )?\w+ (\w+)/g);
    program.attributes = names(/(?:\battribute|^in|\nin) (?:\w+p )?\w+ (\w+)/g);
  }
  getProgramParameter(program: Program, pname: number) {
    return pname === 0x8b82 ? program.linked : pname === 0x8b86 ? program.uniforms.length : pname === 0x8b89 ? program.attributes.length : 0;
  }
  getProgramInfoLog() { return ""; }
  getActiveUniform(program: Program, i: number) { return program.uniforms[i] ? { name: program.uniforms[i], size: 1, type: 0x1406 } : null; }
  getActiveAttrib(program: Program, i: number) { return program.attributes[i] ? { name: program.attributes[i], size: 1, type: 0x8b52 } : null; }
  getAttribLocation(program: Program, name: string) {
    return program.attributes.includes(name) ? program.bindings.get(name) ?? program.attributes.indexOf(name) : -1;
  }
  getUniformLocation(program: Program, name: string) { return program.uniforms.includes(name) ? { name } : null; }
  useProgram(program: Program | null) { this.current = program; }
}

function setup() {
  const gl = new TranslationGl();
  const reg = new GlContextRegistry();
  reg.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 65536 });
  const b = reg.get(1)!;
  b.cmdbufView = new Uint8Array(65536);
  b.gl = gl as unknown as WebGL2RenderingContext;
  const send = (op: number, words: number[], text = "") => {
    const bytes = new TextEncoder().encode(text);
    const view = new DataView(b.cmdbufView!.buffer);
    view.setUint16(0, op, true);
    view.setUint16(2, words.length * 4 + bytes.length, true);
    words.forEach((word, i) => view.setUint32(4 + i * 4, word >>> 0, true));
    b.cmdbufView!.set(bytes, 4 + words.length * 4);
    expect(decodeAndDispatch(b, 0, 4 + words.length * 4 + bytes.length)).toBe(0);
  };
  const named = (op: number, program: number, name: string) => {
    const bytes = new TextEncoder().encode(name), input = new Uint8Array(8 + bytes.length), out = new Uint8Array(12);
    new DataView(input.buffer).setUint32(0, program, true);
    new DataView(input.buffer).setUint32(4, bytes.length, true);
    input.set(bytes, 8);
    expect(runGlQuery(b, op, input, out)).toBe(4);
    return new DataView(out.buffer).getInt32(0, true);
  };
  const activeName = (op: number, program: number, index: number) => {
    const out = new Uint8Array(20 + 64);
    expect(runGlQuery(b, op, new Uint8Array(new Uint32Array([program, index, 0, 64]).buffer), out)).toBe(out.length);
    const length = new DataView(out.buffer).getUint32(4, true);
    return new TextDecoder().decode(out.subarray(16, 16 + length));
  };
  const shader = (name: number, type: number, source: string) => {
    send(O.OP_CREATE_SHADER, [type, name]);
    send(O.OP_SHADER_SOURCE, [name, new TextEncoder().encode(source).length], source);
    send(O.OP_COMPILE_SHADER, [name]);
    return b.shaders.get(name) as unknown as Shader;
  };
  return { gl, b, send, named, activeName, shader };
}

describe("compiling and linking through the host", () => {
  const VERTEX = "attribute vec4 texture;\nattribute vec4 position;\nvoid main() { gl_Position = position + texture; }\n";
  const FRAGMENT = "precision mediump float;\nuniform float sample;\nuniform float plain;\n" +
    "void main() { float s = 0.0; while (s < sample) s += plain; gl_FragColor = vec4(s); }\n";

  it("compiles a shader WebGL rejects only for Appendix A as ESSL 3.00, and links its partner as ESSL 3.00", () => {
    const { b, send, named, activeName, shader } = setup();
    const vertex = shader(1, 0x8b31, VERTEX), fragment = shader(2, 0x8b30, FRAGMENT);
    expect(vertex.source.startsWith("#version 300 es")).toBe(false);
    expect(fragment.source.startsWith("#version 300 es")).toBe(true);
    expect(fragment.compiled).toBe(true);
    send(O.OP_CREATE_PROGRAM, [3]);
    send(O.OP_ATTACH_SHADER, [3, 1]);
    send(O.OP_ATTACH_SHADER, [3, 2]);
    send(O.OP_BIND_ATTRIB_LOCATION, [3, 5, "texture".length], "texture");
    send(O.OP_LINK_PROGRAM, [3]);
    // ES links one language version: the vertex shader was compiled again.
    expect(vertex.source.startsWith("#version 300 es")).toBe(true);
    const program = b.programs.get(3) as unknown as Program;
    expect(program.linked).toBe(true);
    expect(program.uniforms).toEqual(["kandelo_essl1_sample", "plain"]);
    // The guest sees and uses its own names.
    expect([0, 1].map(i => activeName(O.QOP_GET_ACTIVE_UNIFORM_INFO, 3, i))).toEqual(["sample", "plain"]);
    expect(activeName(O.QOP_GET_ACTIVE_ATTRIB, 3, 0)).toBe("texture");
    expect(named(O.QOP_GET_ATTRIB_LOC, 3, "texture")).toBe(5);
    expect(named(O.QOP_GET_UNIFORM_LOC, 3, "sample")).toBeGreaterThanOrEqual(0);
    expect(named(O.QOP_GET_UNIFORM_LOC, 3, "kandelo_essl1_sample")).toBe(-1);
    expect(b.errors).toEqual([]);
    // GetShaderSource still returns the guest's bytes.
    expect(new TextDecoder().decode(b.shaderSources.get(b.shaders.get(2)!))).toBe(FRAGMENT);
  });

  it("keeps the ES 1.00 failure, log and all, when anything else is wrong", () => {
    const { shader } = setup();
    const broken = shader(1, 0x8b30, FRAGMENT.replace("plain;", "plain;\nfloat x = BROKEN;"));
    expect(broken.compiled).toBe(false);
    expect(broken.source.startsWith("#version 300 es")).toBe(false);
    expect(broken.log).toContain("'BROKEN' : undeclared identifier");
    expect(broken.log).toContain("This type of loop is not allowed");
  });

  it("leaves ES 1.00 programs that compile as ES 1.00 alone", () => {
    const { send, shader, activeName } = setup();
    const vertex = shader(1, 0x8b31, VERTEX), fragment = shader(2, 0x8b30, "precision mediump float;\nuniform float sample;\nvoid main() { gl_FragColor = vec4(sample); }\n");
    send(O.OP_CREATE_PROGRAM, [3]);
    send(O.OP_ATTACH_SHADER, [3, 1]);
    send(O.OP_ATTACH_SHADER, [3, 2]);
    send(O.OP_LINK_PROGRAM, [3]);
    expect([vertex, fragment].map(s => [s.source.startsWith("#version 300 es"), s.compiles])).toEqual([[false, 1], [false, 1]]);
    expect(activeName(O.QOP_GET_ACTIVE_UNIFORM_INFO, 3, 0)).toBe("sample");
  });

  it("restores a partner's ES 1.00 compile when its translation fails, leaving the version mismatch to the link", () => {
    const gl = new TranslationGl();
    const translated = gl.createShader(0x8b30), partner = gl.createShader(0x8b31);
    const fragment = "precision mediump float;\nvoid main() { float s = 0.0; while (s < 1.0) s += 1.0; gl_FragColor = vec4(s); }\n";
    const context = gl as unknown as WebGL2RenderingContext;
    recordShaderLanguage(translated as unknown as WebGLShader, compileGuestShader(context, translated as unknown as WebGLShader, fragment, true), fragment, true);
    const vertex = "void main() { gl_Position = vec4(0.0); }\n";
    recordShaderLanguage(partner as unknown as WebGLShader, compileGuestShader(context, partner as unknown as WebGLShader, vertex, false), vertex, false);
    // A translator defect: the partner's translation fails to compile.
    gl.compileShader = function (this: TranslationGl, shader: Shader) {
      TranslationGl.prototype.compileShader.call(this, shader);
      if (shader === partner && shader.source.startsWith("#version 300 es")) { shader.compiled = false; shader.log = "ERROR: defect"; }
    };
    expect(prepareLinkLanguages(context, [translated, partner] as unknown as WebGLShader[])).toBe(true);
    expect(partner.source).toBe(vertex);
    expect(partner.compiled).toBe(true);
  });
});
