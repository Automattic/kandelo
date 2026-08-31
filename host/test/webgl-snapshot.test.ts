import { describe, expect, it } from "vitest";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import {
  captureGlContext,
  GL_ARRAY_BUFFER_BINDING,
  GL_BUFFER_SIZE,
  GL_BUFFER_USAGE,
  GL_COLOR_ATTACHMENT0,
  GL_COPY_READ_BUFFER,
  GL_DEPTH_ATTACHMENT,
  GL_DEPTH_COMPONENT,
  GL_ELEMENT_ARRAY_BUFFER_BINDING,
  GL_FLOAT,
  GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
  GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE,
  GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL,
  GL_FRAMEBUFFER_COMPLETE,
  GL_LINE_WIDTH,
  GL_MAX_VERTEX_ATTRIBS,
  GL_READ_FRAMEBUFFER_BINDING,
  GL_RENDERBUFFER,
  GL_RENDERBUFFER_BINDING,
  GL_RENDERBUFFER_HEIGHT,
  GL_RENDERBUFFER_INTERNAL_FORMAT,
  GL_RENDERBUFFER_WIDTH,
  GL_RG,
  GL_RGBA,
  GL_TEXTURE,
  GL_TEXTURE_MAG_FILTER,
  GL_TEXTURE_MIN_FILTER,
  GL_TEXTURE_WRAP_S,
  GL_TEXTURE_WRAP_T,
  GL_UNSIGNED_BYTE,
  GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING,
  GL_VERTEX_ATTRIB_ARRAY_ENABLED,
  GL_VERTEX_ATTRIB_ARRAY_NORMALIZED,
  GL_VERTEX_ATTRIB_ARRAY_SIZE,
  GL_VERTEX_ATTRIB_ARRAY_STRIDE,
  GL_VERTEX_ATTRIB_ARRAY_TYPE,
} from "../src/webgl/snapshot.js";
import { GL_READ_FRAMEBUFFER } from "../src/webgl/shadow.js";

const GL_COMPILE_STATUS = 0x8b81;
const GL_LINK_STATUS = 0x8b82;
const GL_ACTIVE_UNIFORMS = 0x8b86;
const GL_ACTIVE_ATTRIBUTES = 0x8b89;
const GL_SHADER_TYPE = 0x8b4f;
const GL_PACK_ALIGNMENT = 0x0d05;
const GL_VERTEX_SHADER = 0x8b31;
const GL_FRAGMENT_SHADER = 0x8b30;
const GL_STATIC_DRAW = 0x88e4;
const GL_LINEAR = 0x2601;
const GL_NEAREST = 0x2600;
const GL_CLAMP_TO_EDGE = 0x812f;
const GL_REPEAT = 0x2901;
const GL_RENDERBUFFER_OBJECT = 0x8d41;
const GL_FLOAT_VEC2 = 0x8b50;
const GL_FLOAT_MAT4 = 0x8b5c;
const GL_SAMPLER_2D = 0x8b5e;
const GL_DEPTH_COMPONENT16 = 0x81a5;
const GL_RGBA16F = 0x881a;

type FakeBuffer = { kind: "buffer"; bytes: Uint8Array; usage: number };
type FakeTexture = {
  kind: "texture";
  params: Map<number, number>;
  /** RGBA data per level for readPixels to answer, set by the test. */
  levelRgba: Map<number, Float32Array | Uint8Array>;
};
type FakeShader = { kind: "shader"; type: number; source: string; compiled: boolean };
type FakeUniform = { name: string; type: number; size: number; values: unknown[] };
type FakeProgram = {
  kind: "program";
  attached: FakeShader[];
  linked: boolean;
  attribs: { name: string; location: number }[];
  uniforms: FakeUniform[];
};
type FakeAttrib = {
  enabled: boolean;
  buffer: FakeBuffer | null;
  size: number;
  type: number;
  normalized: boolean;
  stride: number;
  offset: number;
};
type FakeVao = {
  kind: "vao";
  element: FakeBuffer | null;
  attribs: Map<number, FakeAttrib>;
};
type FakeFbo = {
  kind: "fbo";
  attachments: Map<number, { object: FakeTexture | FakeRbo; level: number }>;
};
type FakeRbo = { kind: "rbo"; internalFormat: number; width: number; height: number };

/**
 * Stateful WebGL2 stand-in: enough real state for the snapshot's readback
 * queries to answer truthfully. `RecordingGl` in webgl-bridge.test.ts only
 * records calls; the snapshot asks questions, so this fake holds answers.
 */
class StatefulGl {
  copyReadBuffer: FakeBuffer | null = null;
  arrayBuffer: FakeBuffer | null = null;
  readFbo: FakeFbo | null = null;
  renderbuffer: FakeRbo | null = null;
  activeUnit = 0;
  unitTextures = new Map<number, FakeTexture>();
  defaultVao: FakeVao = { kind: "vao", element: null, attribs: new Map() };
  boundVao: FakeVao;
  packAlignment = 4;
  lineWidth = 1;
  /** The scratch framebuffer the snapshot creates; readPixels answers from
   *  its color attachment. */
  scratchAttachment: { texture: FakeTexture; level: number } | null = null;

  constructor() {
    this.boundVao = this.defaultVao;
  }

  createFramebuffer(): FakeFbo {
    return { kind: "fbo", attachments: new Map() };
  }
  deleteFramebuffer(_fbo: FakeFbo): void {}
  bindFramebuffer(target: number, fbo: FakeFbo | null): void {
    if (target === GL_READ_FRAMEBUFFER) this.readFbo = fbo;
  }
  framebufferTexture2D(
    _target: number,
    attachment: number,
    _textarget: number,
    texture: FakeTexture | null,
    level: number,
  ): void {
    if (attachment !== GL_COLOR_ATTACHMENT0) return;
    this.scratchAttachment = texture === null ? null : { texture, level };
  }
  checkFramebufferStatus(_target: number): number {
    return GL_FRAMEBUFFER_COMPLETE;
  }
  readPixels(
    _x: number,
    _y: number,
    _w: number,
    _h: number,
    _format: number,
    _type: number,
    out: Float32Array | Uint8Array,
  ): void {
    const attached = this.scratchAttachment;
    if (!attached) return;
    const rgba = attached.texture.levelRgba.get(attached.level);
    if (rgba) out.set(rgba as never);
  }

  bindBuffer(target: number, buffer: FakeBuffer | null): void {
    if (target === GL_COPY_READ_BUFFER) this.copyReadBuffer = buffer;
  }
  getBufferParameter(_target: number, pname: number): number {
    if (pname === GL_BUFFER_SIZE) return this.copyReadBuffer?.bytes.byteLength ?? 0;
    if (pname === GL_BUFFER_USAGE) return this.copyReadBuffer?.usage ?? 0;
    return 0;
  }
  getBufferSubData(_target: number, _offset: number, out: Uint8Array): void {
    if (this.copyReadBuffer) out.set(this.copyReadBuffer.bytes);
  }

  bindTexture(_target: number, texture: FakeTexture | null): void {
    if (texture === null) this.unitTextures.delete(this.activeUnit);
    else this.unitTextures.set(this.activeUnit, texture);
  }
  getTexParameter(_target: number, pname: number): number {
    return this.unitTextures.get(this.activeUnit)?.params.get(pname) ?? 0;
  }
  pixelStorei(pname: number, value: number): void {
    if (pname === GL_PACK_ALIGNMENT) this.packAlignment = value;
  }

  bindRenderbuffer(_target: number, rbo: FakeRbo | null): void {
    this.renderbuffer = rbo;
  }
  getRenderbufferParameter(_target: number, pname: number): number {
    const rbo = this.renderbuffer;
    if (!rbo) return 0;
    if (pname === GL_RENDERBUFFER_WIDTH) return rbo.width;
    if (pname === GL_RENDERBUFFER_HEIGHT) return rbo.height;
    if (pname === GL_RENDERBUFFER_INTERNAL_FORMAT) return rbo.internalFormat;
    return 0;
  }

  getShaderSource(shader: FakeShader): string {
    return shader.source;
  }
  getShaderParameter(shader: FakeShader, pname: number): number | boolean {
    if (pname === GL_SHADER_TYPE) return shader.type;
    if (pname === GL_COMPILE_STATUS) return shader.compiled;
    return 0;
  }
  getAttachedShaders(program: FakeProgram): FakeShader[] {
    return program.attached;
  }
  getProgramParameter(program: FakeProgram, pname: number): number | boolean {
    if (pname === GL_LINK_STATUS) return program.linked;
    if (pname === GL_ACTIVE_ATTRIBUTES) return program.attribs.length;
    if (pname === GL_ACTIVE_UNIFORMS) return program.uniforms.length;
    return 0;
  }
  getActiveAttrib(program: FakeProgram, index: number) {
    const attrib = program.attribs[index];
    return attrib ? { name: attrib.name, type: GL_FLOAT_VEC2, size: 1 } : null;
  }
  getAttribLocation(program: FakeProgram, name: string): number {
    return program.attribs.find((attrib) => attrib.name === name)?.location ?? -1;
  }
  getActiveUniform(program: FakeProgram, index: number) {
    const uniform = program.uniforms[index];
    if (!uniform) return null;
    return {
      name: uniform.size > 1 ? `${uniform.name}[0]` : uniform.name,
      type: uniform.type,
      size: uniform.size,
    };
  }
  getUniformLocation(program: FakeProgram, name: string) {
    for (const uniform of program.uniforms) {
      if (uniform.size === 1 && uniform.name === name) {
        return { uniform, element: 0 };
      }
      for (let element = 0; element < uniform.size; element++) {
        if (`${uniform.name}[${element}]` === name) return { uniform, element };
      }
    }
    return null;
  }
  getUniform(
    _program: FakeProgram,
    location: { uniform: FakeUniform; element: number },
  ): unknown {
    return location.uniform.values[location.element];
  }

  bindVertexArray(vao: FakeVao | null): void {
    this.boundVao = vao ?? this.defaultVao;
  }
  getVertexAttrib(index: number, pname: number): unknown {
    const attrib = this.boundVao.attribs.get(index);
    if (!attrib) {
      return pname === GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING ? null : false;
    }
    switch (pname) {
      case GL_VERTEX_ATTRIB_ARRAY_ENABLED: return attrib.enabled;
      case GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING: return attrib.buffer;
      case GL_VERTEX_ATTRIB_ARRAY_SIZE: return attrib.size;
      case GL_VERTEX_ATTRIB_ARRAY_TYPE: return attrib.type;
      case GL_VERTEX_ATTRIB_ARRAY_NORMALIZED: return attrib.normalized;
      case GL_VERTEX_ATTRIB_ARRAY_STRIDE: return attrib.stride;
      default: return 0;
    }
  }
  getVertexAttribOffset(index: number, _pname: number): number {
    return this.boundVao.attribs.get(index)?.offset ?? 0;
  }

  getFramebufferAttachmentParameter(
    _target: number,
    attachment: number,
    pname: number,
  ): unknown {
    const attached = this.readFbo?.attachments.get(attachment);
    if (!attached) return pname === GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE ? 0 : null;
    if (pname === GL_FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE) {
      return attached.object.kind === "texture" ? GL_TEXTURE : GL_RENDERBUFFER_OBJECT;
    }
    if (pname === GL_FRAMEBUFFER_ATTACHMENT_OBJECT_NAME) return attached.object;
    if (pname === GL_FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL) return attached.level;
    return null;
  }

  getParameter(pname: number): unknown {
    switch (pname) {
      case GL_COPY_READ_BUFFER: return this.copyReadBuffer;
      case GL_READ_FRAMEBUFFER_BINDING: return this.readFbo;
      case GL_RENDERBUFFER_BINDING: return this.renderbuffer;
      case GL_ARRAY_BUFFER_BINDING: return this.arrayBuffer;
      case GL_ELEMENT_ARRAY_BUFFER_BINDING: return this.boundVao.element;
      case GL_MAX_VERTEX_ATTRIBS: return 16;
      case GL_LINE_WIDTH: return this.lineWidth;
      default: return 0;
    }
  }
}

function makeBinding(gl: StatefulGl | null): GlBinding {
  const reg = new GlContextRegistry();
  reg.bind({ pid: 9, cmdbufAddr: 4096, cmdbufLen: 1024 });
  const b = reg.get(9)!;
  b.gl = gl as unknown as WebGL2RenderingContext | null;
  b.contextId = 3;
  b.surfaceId = 4;
  return b;
}

function fakeBuffer(bytes: number[], usage = GL_STATIC_DRAW): FakeBuffer {
  return { kind: "buffer", bytes: new Uint8Array(bytes), usage };
}

function fakeTexture(): FakeTexture {
  return {
    kind: "texture",
    params: new Map([
      [GL_TEXTURE_MIN_FILTER, GL_LINEAR],
      [GL_TEXTURE_MAG_FILTER, GL_NEAREST],
      [GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE],
      [GL_TEXTURE_WRAP_T, GL_REPEAT],
    ]),
    levelRgba: new Map(),
  };
}

describe("captureGlContext", () => {
  it("carries the binding without a context as structure alone", () => {
    const b = makeBinding(null);
    b.uniformLocationNames.set(2, { program: 7, uniform: "u_color" });
    b.nextUniformLoc = 2;

    const captured = captureGlContext(b, 1);

    expect(captured.pid).toBe(9);
    expect(captured.cmdbufAddr).toBe(4096);
    expect(captured.cmdbufLen).toBe(1024);
    expect(captured.contextId).toBe(3);
    expect(captured.surfaceId).toBe(4);
    expect(captured.crtcId).toBe(1);
    expect(captured.state).toBeNull();
    expect(captured.uniformLocationNames).toEqual([
      { index: 2, program: 7, uniform: "u_color" },
    ]);
    expect(captured.nextUniformLoc).toBe(2);
  });

  it("reads buffer contents and usage back", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    b.buffers.set(42, fakeBuffer([1, 2, 3, 4]) as unknown as WebGLBuffer);

    const captured = captureGlContext(b, null);

    expect(captured.buffers).toEqual([
      { name: 42, usage: GL_STATIC_DRAW, bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);
  });

  it("reads a byte texture level back through the scratch framebuffer", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const texture = fakeTexture();
    texture.levelRgba.set(0, new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]));
    b.textures.set(5, texture as unknown as WebGLTexture);
    b.textureShapes.set(5, {
      mipmapped: false,
      levels: new Map([[0, {
        internalFormat: GL_RGBA,
        width: 2,
        height: 1,
        format: GL_RGBA,
        type: GL_UNSIGNED_BYTE,
      }]]),
    });

    const captured = captureGlContext(b, null);

    expect(captured.textures).toHaveLength(1);
    const level = captured.textures[0]!.levels[0]!;
    expect(level.pixels).toEqual(new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]));
    expect(level.pixelsType).toBe(GL_UNSIGNED_BYTE);
    expect(captured.textures[0]!.minFilter).toBe(GL_LINEAR);
    expect(captured.textures[0]!.magFilter).toBe(GL_NEAREST);
    expect(captured.textures[0]!.wrapS).toBe(GL_CLAMP_TO_EDGE);
    expect(captured.textures[0]!.wrapT).toBe(GL_REPEAT);
    expect(captured.boundaries).toEqual([]);
  });

  it("extracts the carried channels from a float RG texture", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const texture = fakeTexture();
    texture.levelRgba.set(0, new Float32Array([
      0.5, 0.25, 0, 1,
      -1.5, 2.5, 0, 1,
    ]));
    b.textures.set(6, texture as unknown as WebGLTexture);
    b.textureShapes.set(6, {
      mipmapped: true,
      levels: new Map([[0, {
        internalFormat: 0x8230, // RG16F
        width: 2,
        height: 1,
        format: GL_RG,
        type: GL_FLOAT,
      }]]),
    });

    const captured = captureGlContext(b, null);

    const level = captured.textures[0]!.levels[0]!;
    expect(level.pixelsType).toBe(GL_FLOAT);
    expect(new Float32Array(
      level.pixels!.buffer,
      level.pixels!.byteOffset,
      4,
    )).toEqual(new Float32Array([0.5, 0.25, -1.5, 2.5]));
    expect(captured.textures[0]!.mipmapped).toBe(true);
  });

  it("carries a depth texture level as a named boundary, not pixels", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    b.textures.set(7, fakeTexture() as unknown as WebGLTexture);
    b.textureShapes.set(7, {
      mipmapped: false,
      levels: new Map([[0, {
        internalFormat: GL_DEPTH_COMPONENT16,
        width: 4,
        height: 4,
        format: GL_DEPTH_COMPONENT,
        type: GL_UNSIGNED_BYTE,
      }]]),
    });

    const captured = captureGlContext(b, null);

    expect(captured.textures[0]!.levels[0]!.pixels).toBeNull();
    expect(captured.boundaries.some((line) => line.includes("depth"))).toBe(true);
  });

  it("carries a never-uploaded texture as empty without a boundary", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    b.textures.set(8, fakeTexture() as unknown as WebGLTexture);

    const captured = captureGlContext(b, null);

    expect(captured.textures[0]!.levels).toEqual([]);
    expect(captured.boundaries).toEqual([]);
  });

  it("reads shaders and programs back, pinning attribute locations", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const vertex: FakeShader = {
      kind: "shader",
      type: GL_VERTEX_SHADER,
      source: "void main(){}",
      compiled: true,
    };
    const fragment: FakeShader = {
      kind: "shader",
      type: GL_FRAGMENT_SHADER,
      source: "void main(){gl_FragColor=vec4(1.);}",
      compiled: true,
    };
    b.shaders.set(1, vertex as unknown as WebGLShader);
    const program: FakeProgram = {
      kind: "program",
      attached: [vertex, fragment],
      linked: true,
      attribs: [{ name: "aPosition", location: 3 }],
      uniforms: [
        { name: "uTexelSize", type: GL_FLOAT_VEC2, size: 1, values: [new Float32Array([0.5, 0.25])] },
        { name: "uSampler", type: GL_SAMPLER_2D, size: 1, values: [2] },
        { name: "uWeights", type: GL_FLOAT_MAT4, size: 2, values: [
          new Float32Array(16).fill(1),
          new Float32Array(16).fill(2),
        ] },
      ],
    };
    b.programs.set(20, program as unknown as WebGLProgram);

    const captured = captureGlContext(b, null);

    expect(captured.shaders).toEqual([
      {
        name: 1,
        type: GL_VERTEX_SHADER,
        source: "void main(){}",
        compiled: true,
      },
    ]);
    const carried = captured.programs[0]!;
    expect(carried.name).toBe(20);
    expect(carried.linked).toBe(true);
    expect(carried.shaders).toEqual([
      { shaderName: 1, type: GL_VERTEX_SHADER, source: "void main(){}" },
      {
        shaderName: null,
        type: GL_FRAGMENT_SHADER,
        source: "void main(){gl_FragColor=vec4(1.);}",
      },
    ]);
    expect(carried.attribBindings).toEqual([{ name: "aPosition", location: 3 }]);
    expect(carried.uniforms).toEqual([
      { name: "uTexelSize", glType: GL_FLOAT_VEC2, values: [0.5, 0.25] },
      { name: "uSampler", glType: GL_SAMPLER_2D, values: [2] },
      { name: "uWeights[0]", glType: GL_FLOAT_MAT4, values: new Array(16).fill(1) },
      { name: "uWeights[1]", glType: GL_FLOAT_MAT4, values: new Array(16).fill(2) },
    ]);
  });

  it("reads vertex-array wiring back by buffer name", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const position = fakeBuffer([0, 0, 0, 0]);
    const indices = fakeBuffer([1, 1]);
    b.buffers.set(30, position as unknown as WebGLBuffer);
    b.buffers.set(31, indices as unknown as WebGLBuffer);
    const vao: FakeVao = {
      kind: "vao",
      element: indices,
      attribs: new Map([[2, {
        enabled: true,
        buffer: position,
        size: 2,
        type: GL_FLOAT,
        normalized: false,
        stride: 8,
        offset: 16,
      }]]),
    };
    b.vaos.set(40, vao as unknown as WebGLVertexArrayObject);
    gl.defaultVao.attribs.set(0, {
      enabled: true,
      buffer: position,
      size: 4,
      type: GL_FLOAT,
      normalized: true,
      stride: 0,
      offset: 0,
    });

    const captured = captureGlContext(b, null);

    expect(captured.vaos).toEqual([
      {
        name: 0,
        elementArrayBufferName: null,
        attribs: [{
          index: 0,
          enabled: true,
          bufferName: 30,
          size: 4,
          type: GL_FLOAT,
          normalized: true,
          stride: 0,
          offset: 0,
        }],
      },
      {
        name: 40,
        elementArrayBufferName: 31,
        attribs: [{
          index: 2,
          enabled: true,
          bufferName: 30,
          size: 2,
          type: GL_FLOAT,
          normalized: false,
          stride: 8,
          offset: 16,
        }],
      },
    ]);
  });

  it("reads framebuffer attachments and renderbuffer storage back", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const texture = fakeTexture();
    b.textures.set(5, texture as unknown as WebGLTexture);
    const rbo: FakeRbo = {
      kind: "rbo",
      internalFormat: GL_DEPTH_COMPONENT16,
      width: 64,
      height: 48,
    };
    b.rbos.set(50, rbo as unknown as WebGLRenderbuffer);
    const fbo: FakeFbo = {
      kind: "fbo",
      attachments: new Map([
        [GL_COLOR_ATTACHMENT0, { object: texture, level: 1 }],
        [GL_DEPTH_ATTACHMENT, { object: rbo, level: 0 }],
      ]),
    };
    b.fbos.set(60, fbo as unknown as WebGLFramebuffer);

    const captured = captureGlContext(b, null);

    expect(captured.fbos).toEqual([{
      name: 60,
      attachments: [
        { attachment: GL_COLOR_ATTACHMENT0, kind: "texture", objectName: 5, level: 1 },
        { attachment: GL_DEPTH_ATTACHMENT, kind: "renderbuffer", objectName: 50, level: 0 },
      ],
    }]);
    expect(captured.rbos).toEqual([{
      name: 50,
      internalFormat: GL_DEPTH_COMPONENT16,
      width: 64,
      height: 48,
    }]);
    expect(captured.boundaries.some(
      (line) => line.includes("renderbuffer contents"),
    )).toBe(true);
  });

  it("names the pipeline state through the shadow", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const program: FakeProgram = {
      kind: "program",
      attached: [],
      linked: false,
      attribs: [],
      uniforms: [],
    };
    b.programs.set(20, program as unknown as WebGLProgram);
    const vao: FakeVao = { kind: "vao", element: null, attribs: new Map() };
    b.vaos.set(40, vao as unknown as WebGLVertexArrayObject);
    const fbo: FakeFbo = { kind: "fbo", attachments: new Map() };
    b.fbos.set(60, fbo as unknown as WebGLFramebuffer);
    const texture = fakeTexture();
    b.textures.set(5, texture as unknown as WebGLTexture);
    const buffer = fakeBuffer([9]);
    b.buffers.set(30, buffer as unknown as WebGLBuffer);
    gl.arrayBuffer = buffer;
    gl.lineWidth = 2;
    b.shadow.currentProgram = program as unknown as WebGLProgram;
    b.shadow.vao = vao as unknown as WebGLVertexArrayObject;
    b.shadow.fbo = fbo as unknown as WebGLFramebuffer;
    b.shadow.viewport = [0, 0, 320, 200];
    b.shadow.blendEnabled = true;
    b.shadow.activeTexture = 3;
    b.textureUnitNames.set(3, 5);

    const captured = captureGlContext(b, null);

    const state = captured.state!;
    expect(state.currentProgramName).toBe(20);
    expect(state.vaoName).toBe(40);
    expect(state.fboName).toBe(60);
    expect(state.readFboName).toBe(0);
    expect(state.viewport).toEqual([0, 0, 320, 200]);
    expect(state.blendEnabled).toBe(true);
    expect(state.activeTexture).toBe(3);
    expect(state.textureUnits).toEqual([{ unit: 3, name: 5 }]);
    expect(state.arrayBufferName).toBe(30);
    expect(state.lineWidth).toBe(2);
  });

  it("leaves the context's bindings as it found them", () => {
    const gl = new StatefulGl();
    const b = makeBinding(gl);
    const buffer = fakeBuffer([1]);
    b.buffers.set(30, buffer as unknown as WebGLBuffer);
    const texture = fakeTexture();
    texture.levelRgba.set(0, new Uint8Array([1, 2, 3, 4]));
    b.textures.set(5, texture as unknown as WebGLTexture);
    b.textureShapes.set(5, {
      mipmapped: false,
      levels: new Map([[0, {
        internalFormat: GL_RGBA,
        width: 1,
        height: 1,
        format: GL_RGBA,
        type: GL_UNSIGNED_BYTE,
      }]]),
    });
    const vao: FakeVao = { kind: "vao", element: null, attribs: new Map() };
    b.vaos.set(40, vao as unknown as WebGLVertexArrayObject);

    const priorCopyRead = fakeBuffer([7]);
    gl.copyReadBuffer = priorCopyRead;
    const priorTexture = fakeTexture();
    gl.unitTextures.set(0, priorTexture);
    b.shadow.textureUnits[0] = priorTexture as unknown as WebGLTexture;
    b.shadow.vao = vao as unknown as WebGLVertexArrayObject;
    gl.boundVao = vao;
    gl.packAlignment = 2;
    b.shadow.packAlignment = 2;

    captureGlContext(b, null);

    expect(gl.copyReadBuffer).toBe(priorCopyRead);
    expect(gl.readFbo).toBeNull();
    expect(gl.unitTextures.get(0)).toBe(priorTexture);
    expect(gl.boundVao).toBe(vao);
    expect(gl.packAlignment).toBe(2);
  });
});
