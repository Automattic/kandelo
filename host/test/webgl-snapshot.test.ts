import { describe, expect, it } from "vitest";
import { GlContextRegistry, type GlBinding, type GpuBo } from "../src/webgl/registry.js";
import { recordTextureLevel, type GlTextureLevel } from "../src/webgl/texture-levels.js";
import { registerCubeTexture } from "../src/webgl/cube-storage.js";
import { captureGlSession, captureGpuBo, GlCaptureRefusal, halfBits } from "../src/webgl/snapshot.js";
import type { GlImageSource } from "../src/webgl/image-storage.js";

const GL_RGBA = 0x1908, GL_RGB = 0x1907, GL_LUMINANCE = 0x1909, GL_DEPTH_COMPONENT = 0x1902;
const GL_UNSIGNED_BYTE = 0x1401, GL_FLOAT = 0x1406, GL_HALF_FLOAT = 0x140b, GL_UNSIGNED_SHORT = 0x1403;

/** Answers the reads a capture makes: every readPixels returns `texels`
 * (RGBA, as floats or bytes by the requested type). */
function readbackGl(texels: readonly number[]) {
  const pixelStores: [number, number][] = [];
  const gl = {
    getParameter: () => null,
    createFramebuffer: () => ({}),
    deleteFramebuffer: () => {},
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    checkFramebufferStatus: () => 0x8cd5,
    bindTexture: () => {},
    bindBuffer: () => {},
    getBufferSubData: () => {},
    getTexParameter: (_target: number, pname: number) => pname,
    pixelStorei: (pname: number, value: number) => { pixelStores.push([pname, value]); },
    readPixels: (_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, out: Float32Array | Uint8Array) => {
      out.set(texels.slice(0, out.length));
    },
  };
  return { gl: gl as unknown as WebGL2RenderingContext, pixelStores };
}

function binding(gl: WebGL2RenderingContext | null): GlBinding {
  const registry = new GlContextRegistry();
  registry.bind({ pid: 9, sessionId: 2, displayFileId: 5n, cmdbufAddr: 4096, cmdbufLen: 1024 });
  const b = registry.get(9, 2)!;
  b.gl = gl;
  b.contextId = 3;
  return b;
}

function texture(b: GlBinding, name: number, spec: Omit<GlTextureLevel, "compressed">): WebGLTexture {
  const object = {} as WebGLTexture;
  b.textures.set(name, object);
  recordTextureLevel(object, 0x0de1, 0, { ...spec, compressed: false });
  return object;
}

describe("halfBits", () => {
  it("rounds to the nearest binary16, ties to even", () => {
    expect([1, -2, 0.1, 65504, 65520, 2 ** -24, 2 ** -26, 0, Infinity].map(halfBits))
      .toEqual([0x3c00, 0xc000, 0x2e66, 0x7bff, 0x7c00, 0x0001, 0x0000, 0x0000, 0x7c00]);
    expect(halfBits(Number.NaN) & 0x7c00).toBe(0x7c00);
    expect(halfBits(Number.NaN) & 0x3ff).not.toBe(0);
  });
});

describe("captureGlSession", () => {
  it("carries a session without a renderer as identity alone", () => {
    const b = binding(null);
    b.contextId = null;
    expect(captureGlSession(b, 4, 0)).toMatchObject({
      pid: 9,
      sessionId: 2,
      displayFileId: "5",
      cmdbufAddr: 4096,
      cmdbufLen: 1024,
      crtcId: 4,
      surface: null,
      context: null,
      drawable: null,
      buffers: [],
      textures: [],
      state: null,
    });
  });

  it("packs a half-float level's texels as the guest's halves", () => {
    const b = binding(readbackGl([0.5, 1, -2, 0.25]).gl);
    texture(b, 3, {
      width: 1, height: 1, internalFormat: 0x881a, format: GL_RGBA, type: GL_HALF_FLOAT,
      gles: { internalFormat: GL_RGBA, format: GL_RGBA, type: GL_HALF_FLOAT, expanded: false,
        colorRenderable: true, depth: false, stencil: false },
    });
    const [level] = captureGlSession(b, null, 0).textures[0]!.levels;
    expect(level).toMatchObject({ internalFormat: GL_RGBA, format: GL_RGBA, type: GL_HALF_FLOAT });
    expect([...new Uint16Array(level!.pixels!.buffer)]).toEqual([0x3800, 0x3c00, 0xc000, 0x3400]);
  });

  it("drops the alpha a byte RGB level is read back with", () => {
    const b = binding(readbackGl([1, 2, 3, 255, 4, 5, 6, 255]).gl);
    texture(b, 3, {
      width: 2, height: 1, internalFormat: 0x8058, format: GL_RGBA, type: GL_UNSIGNED_BYTE,
      gles: { internalFormat: GL_RGB, format: GL_RGB, type: GL_UNSIGNED_BYTE, expanded: false,
        colorRenderable: true, depth: false, stencil: false },
    });
    expect([...captureGlSession(b, null, 0).textures[0]!.levels[0]!.pixels!]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("carries an expanded float luminance level's one channel", () => {
    const b = binding(readbackGl([0.75, 0.75, 0.75, 1]).gl);
    texture(b, 3, {
      width: 1, height: 1, internalFormat: 0x8814, format: GL_RGBA, type: GL_FLOAT,
      gles: { internalFormat: GL_LUMINANCE, format: GL_LUMINANCE, type: GL_FLOAT, expanded: true,
        colorRenderable: false, depth: false, stencil: false },
    });
    expect([...new Float32Array(captureGlSession(b, null, 0).textures[0]!.levels[0]!.pixels!.buffer)]).toEqual([0.75]);
  });

  it("names the levels it cannot read instead of carrying texels", () => {
    const b = binding(readbackGl([]).gl);
    texture(b, 3, {
      width: 1, height: 1, internalFormat: 0x81a6, format: GL_DEPTH_COMPONENT, type: GL_UNSIGNED_SHORT,
      gles: { internalFormat: GL_DEPTH_COMPONENT, format: GL_DEPTH_COMPONENT, type: GL_UNSIGNED_SHORT,
        expanded: false, colorRenderable: false, depth: true, stencil: false },
    });
    texture(b, 4, {
      width: 1, height: 1, internalFormat: GL_LUMINANCE, format: GL_LUMINANCE, type: GL_UNSIGNED_BYTE,
      gles: { internalFormat: GL_LUMINANCE, format: GL_LUMINANCE, type: GL_UNSIGNED_BYTE,
        expanded: false, colorRenderable: false, depth: false, stencil: false },
    });
    const captured = captureGlSession(b, null, 0);
    expect(captured.textures.map((carried) => carried.levels[0]!.pixels)).toEqual([null, null]);
    expect(captured.boundaries).toEqual([
      "texture 3 level 0 holds depth or stencil data; restored uninitialized",
      "texture 4 level 0 is not readable as a color attachment; restored uninitialized",
    ]);
  });

  it("carries foreign textures apart from the guest's own", () => {
    const b = binding(readbackGl([1, 2, 3, 4]).gl);
    const cpu = {} as WebGLTexture, gpu = {} as WebGLTexture;
    b.textures.set(0x4000_0000, cpu);
    b.foreignTextureBos.set(cpu, 5);
    b.foreignTextures.set(5, { tex: cpu, texId: 0x4000_0000, w: 1, h: 1, scratch: null });
    recordTextureLevel(cpu, 0x0de1, 0, {
      width: 1, height: 1, internalFormat: GL_RGBA, format: GL_RGBA, type: GL_UNSIGNED_BYTE, compressed: false,
    });
    const source = { token: 1, bo: 6, texture: {} as WebGLTexture, width: 2, height: 2 } as GlImageSource;
    b.imageSources.set(1, source);
    b.textures.set(0x6000_0000, gpu);
    b.foreignTextureBos.set(gpu, 6);
    b.foreignTextures.set(6, { tex: gpu, texId: 0x6000_0000, w: 2, h: 2, scratch: null });
    b.textureViews.set(gpu, { native: {} as WebGLTexture, source, read: null });
    b.nextForeignTexId = 0x4000_0001;

    const captured = captureGlSession(b, null, 0);

    expect(captured.textures).toEqual([]);
    expect(captured.nextForeignTexId).toBe(0x4000_0001);
    const parameters = { minFilter: 0x2801, magFilter: 0x2800, wrapS: 0x2802, wrapT: 0x2803 };
    expect(captured.foreignTextures).toEqual([
      { name: 0x4000_0000, boId: 5, width: 1, height: 1, pixels: new Uint8Array([1, 2, 3, 4]), ...parameters },
      { name: 0x6000_0000, boId: 6, width: 2, height: 2, pixels: null, ...parameters },
    ]);
  });

  it("refuses what a rebuild cannot reproduce", () => {
    const refused = (setup: (b: GlBinding) => void, reason: RegExp) => {
      const b = binding(readbackGl([]).gl);
      setup(b);
      expect(() => captureGlSession(b, null, 0)).toThrow(GlCaptureRefusal);
      expect(() => captureGlSession(b, null, 0)).toThrow(reason);
    };
    refused((b) => { b.objects.members.add(binding(null)); }, /shares objects with another context/);
    refused((b) => {
      b.foreignTextures.set(1, { tex: {} as WebGLTexture, texId: 0x4000_0000, w: 1, h: 1, scratch: null });
    }, /still uses an object the guest deleted/);
    refused((b) => {
      const respecified = texture(b, 0x4000_0000, {
        width: 1, height: 1, internalFormat: 0x8058, format: GL_RGBA, type: GL_UNSIGNED_BYTE,
        gles: { internalFormat: GL_RGBA, format: GL_RGBA, type: GL_UNSIGNED_BYTE, expanded: false,
          colorRenderable: true, depth: false, stencil: false },
      });
      b.foreignTextures.set(1, { tex: respecified, texId: 0x4000_0000, w: 1, h: 1, scratch: null });
    }, /respecified foreign texture 1073741824/);
    refused((b) => {
      const sibling = {} as WebGLTexture;
      b.textures.set(3, sibling);
      b.textureViews.set(sibling, { native: {} as WebGLTexture, source: null, read: null });
    }, /holds an EGLImage texture/);
    refused((b) => {
      b.imageSources.set(1, { token: 1, bo: 6, texture: null, width: 1, height: 1 });
    }, /holds an EGLImage/);
    refused((b) => { b.retiredBuffers.set({} as WebGLBuffer, 1); }, /still uses an object the guest deleted/);
    refused((b) => { b.surface.samples = 4; }, /multisampled surface/);
    refused((b) => { b.shadow.defaultTextures.set(0x0de1, {} as WebGLTexture); }, /texture zero's storage/);
    refused((b) => { b.uniformUpload = {} as GlBinding["uniformUpload"]; }, /inside a staged upload/);
    refused((b) => {
      b.currentProgram = {} as WebGLProgram;
      b.currentProgramId = 5;
    }, /latest relink failed/);
    refused((b) => {
      const shader = {} as WebGLShader;
      b.shaders.set(5, shader);
      b.shaderSources.set(shader, new Uint8Array(0x10000));
    }, /shader 5's source is longer than one command record carries/);
    refused((b) => {
      const draw = {} as WebGLFramebuffer;
      b.fbos.set(4, draw);
      b.shadow.fbo = draw;
    }, /draws and reads different framebuffers/);
    refused((b) => {
      const cube = {} as WebGLTexture;
      registerCubeTexture(cube, cube);
      b.textures.set(3, cube);
    }, /cube-map texture/);
  });
});

describe("captureGpuBo", () => {
  it("reads a GPU BO's RGBA8 texels through its framebuffer", () => {
    const { gl, pixelStores } = readbackGl([1, 2, 3, 4]);
    const bo = { gl, fbo: {}, texId: 0x6000_0000, w: 1, h: 1, internalFormat: 0x8058, drmFormat: 0x34325258 } as unknown as GpuBo;
    expect(captureGpuBo(gl, 7, bo)).toEqual({
      boId: 7, texId: 0x6000_0000, width: 1, height: 1, format: 0x34325258, pixels: new Uint8Array([1, 2, 3, 4]),
    });
    expect(pixelStores).toContainEqual([0x0d05, 1]);
  });

  it("refuses storage it does not carry", () => {
    const { gl } = readbackGl([]);
    const bo = { gl, fbo: {}, w: 1, h: 1, internalFormat: 0x881a, drmFormat: 0 } as unknown as GpuBo;
    expect(() => captureGpuBo(gl, 7, bo)).toThrow(/GPU BO 7 uses storage 0x881a/);
  });
});
