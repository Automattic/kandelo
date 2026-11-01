/**
 * The CRTC color stage on the GPU: the cursor plane blended over the
 * primary, then the legacy gamma LUT (kms-gamma.ts), applied by a fragment
 * shader while the frame is drawn. The LUT and the cursor image are small
 * textures uploaded only when they change, so a GL presentation path with a
 * LUT costs one extra draw per present and never reads the frame back.
 *
 * The shader reproduces the CPU stage (kmsCrtcOutput) bit for bit:
 * - every channel is first recovered as its 8-bit value: an RGB565 channel
 *   by bit replication, a 10-bit channel as round(v * 255 / 1023) (never a
 *   tie), a half float clamped to [0, 1] (NaN as 0) as floor(f * 255 + 0.5),
 *   exactly as scanoutRgba reduces them (an 8-bpc output; scanout-format.ts);
 * - the premultiplied cursor blends as round(c + p * (255 - a) / 255),
 *   clamped to 255; the fractional part of p * (255 - a) / 255 is k / 255,
 *   never one half, so floor(x + 0.5) rounds exactly as Math.round does;
 * - each 8-bit value indexes the 256-entry table with texelFetch, and the
 *   8-bit result is written to an 8-bit color buffer, which stores it
 *   exactly.
 *
 * Callers hold the kernel's generic presentation scope
 * (`withGraphicsState`): the stage selects its own program, vertex array,
 * textures, samplers, framebuffers and fixed-function state, and the guest's
 * logical context is replayed in full before its next command. Every native
 * error is captured by that scope and fails the present.
 */
import type { KmsCursor } from "../dri/cursor-plane.js";
import type { KmsGamma } from "../dri/kms-gamma.js";
import { ScanoutEncoding } from "../dri/scanout-format.js";
import { rethrowNativeGlFault } from "./native-recovery.js";

/** The texture storage a captured frame keeps, by the source's sized
 *  internal format: a blit between identical formats copies every value,
 *  so a 10-bit or half-float frame reaches the shader's reduction intact. */
const FRAME_STORAGE: Record<number, { format: number; type: number; encoding: ScanoutEncoding }> = {
  0x8058: { format: 0x1908, type: 0x1401, encoding: ScanoutEncoding.Unorm8 },   // RGBA8
  0x8229: { format: 0x1903, type: 0x1401, encoding: ScanoutEncoding.Unorm8 },   // R8
  0x822b: { format: 0x8227, type: 0x1401, encoding: ScanoutEncoding.Unorm8 },   // RG8
  0x8d62: { format: 0x1907, type: 0x8363, encoding: ScanoutEncoding.Rgb565 },   // RGB565
  0x8059: { format: 0x1908, type: 0x8368, encoding: ScanoutEncoding.Unorm10 },  // RGB10_A2
  0x881a: { format: 0x1908, type: 0x140b, encoding: ScanoutEncoding.Float },    // RGBA16F
};
const RGBA8 = 0x8058;

/** Texture units the stage samples: the frame, the LUT and the cursor. */
const FRAME_UNIT = 0, LUT_UNIT = 1, CURSOR_UNIT = 2;

// Fullscreen triangle from gl_VertexID; the fragment shader addresses
// texels from gl_FragCoord, so no varyings are needed.
const KMS_COLOR_STAGE_VS = `#version 300 es
void main() {
  vec2 pos = vec2(float((gl_VertexID & 1) << 2) - 1.0,
                  float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const KMS_COLOR_STAGE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_frame;
uniform highp sampler2D u_lut;
uniform highp sampler2D u_cursor;
uniform ivec2 u_size;
uniform ivec4 u_cursor_rect;
uniform bool u_frame_top_first;
uniform bool u_target_top_first;
uniform bool u_bgr;
uniform int u_encoding;
uniform bool u_opaque;
uniform bool u_lut_enabled;
out vec4 o_color;
void main() {
  ivec2 frag = ivec2(gl_FragCoord.xy);
  int row = u_target_top_first ? frag.y : u_size.y - 1 - frag.y;
  ivec2 crtc = ivec2(frag.x, row);
  vec4 texel = texelFetch(u_frame, ivec2(crtc.x, u_frame_top_first ? row : u_size.y - 1 - row), 0);
  vec3 color;
  if (u_encoding == 1) {
    vec3 q = floor(texel.rgb * vec3(31.0, 63.0, 31.0) + 0.5);
    color = vec3(q.r * 8.0 + floor(q.r / 4.0), q.g * 4.0 + floor(q.g / 16.0), q.b * 8.0 + floor(q.b / 4.0));
  } else if (u_encoding == 2) {
    vec3 v = floor(texel.rgb * 1023.0 + 0.5);
    color = floor((v * 510.0 + 1023.0) / 2046.0);
  } else if (u_encoding == 3) {
    vec3 f = vec3(isnan(texel.r) ? 0.0 : texel.r, isnan(texel.g) ? 0.0 : texel.g, isnan(texel.b) ? 0.0 : texel.b);
    color = floor(clamp(f, 0.0, 1.0) * 255.0 + 0.5);
  } else {
    color = floor(texel.rgb * 255.0 + 0.5);
  }
  if (u_bgr) color = color.bgr;
  if (u_lut_enabled) {
    ivec2 at = crtc - u_cursor_rect.xy;
    if (all(greaterThanEqual(at, ivec2(0))) && all(lessThan(at, u_cursor_rect.zw))) {
      vec4 p = floor(texelFetch(u_cursor, at, 0) * 255.0 + 0.5);
      color = min(vec3(255.0), floor(p.rgb + color * (255.0 - p.a) / 255.0 + 0.5));
    }
    ivec3 index = ivec3(color);
    color = vec3(texelFetch(u_lut, ivec2(index.r, 0), 0).r,
                 texelFetch(u_lut, ivec2(index.g, 0), 0).g,
                 texelFetch(u_lut, ivec2(index.b, 0), 0).b) * 255.0;
  }
  o_color = vec4(color / 255.0, u_opaque ? 1.0 : texel.a);
}
`;

/** Where the stage reads the CRTC's planes. */
export interface KmsColorStageSource {
  texture: WebGLTexture;
  /** Texel row zero is the CRTC's top row (KMS buffer order) rather than
   *  its bottom row (GL order). */
  topFirst: boolean;
  /** The texture holds DRM XRGB/ARGB8888 bytes uploaded as RGBA. */
  bgr: boolean;
  /** How the texture holds each channel (ScanoutEncoding). */
  encoding: ScanoutEncoding;
  /** The primary plane is opaque: alpha is not taken from the texture. */
  opaque: boolean;
}

/** Reset the fixed-function state that would alter a fullscreen draw or a
 *  tightly packed upload. Shared by every KMS presenter. */
export function resetKmsGlState(gl: WebGL2RenderingContext): void {
  // KMS presentation shares the physical renderer with live GLES contexts.
  // Re-establish every upload/draw dependency on each accepted frame; the
  // graphics scope invalidates the muxer so the next GLES command restores
  // its logical context rather than inheriting presenter state.
  //
  // Draw target and pipeline.
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
  gl.disable(gl.SCISSOR_TEST);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
  gl.disable(gl.SAMPLE_COVERAGE);
  gl.disable(gl.RASTERIZER_DISCARD);
  gl.colorMask(true, true, true, true);
  // Texture unit 0: a bound sampler object would override the scanout
  // texture's own filtering and wrap parameters.
  gl.activeTexture(gl.TEXTURE0);
  gl.bindSampler(0, null);
  // Upload: texImage2D/texSubImage2D read their source as tightly packed
  // rows from its start. A bound PIXEL_UNPACK_BUFFER makes them read a
  // buffer object instead (and reject an ArrayBufferView source), and any
  // non-default unpack parameter reshapes or offsets the rows.
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
  gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
}

function compileProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("KMS color stage: shader allocation failed");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`KMS color stage: shader compile failed: ${log}`);
    }
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, vertex);
  let fs: WebGLShader;
  try { fs = compile(gl.FRAGMENT_SHADER, fragment); }
  catch (error) { gl.deleteShader(vs); throw error; }
  const program = gl.createProgram();
  if (program) {
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
  }
  // A linked program keeps its code; the shader objects are not needed.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!program) throw new Error("KMS color stage: program allocation failed");
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`KMS color stage: program link failed: ${log}`);
  }
  return program;
}

type StageTarget = { texture: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number; internalFormat: number };

type Uniforms = Record<"size" | "cursorRect" | "frameTopFirst" | "targetTopFirst" | "bgr" | "encoding"
  | "opaque" | "lutEnabled", WebGLUniformLocation | null>;

/** The color stage's GPU objects on one WebGL2 context. */
export class KmsColorStage {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  /** NEAREST, non-mipmapped sampling for every stage unit: texelFetch needs
   *  a complete texture, and a source's own filter may name mipmaps it has
   *  not generated. */
  private readonly sampler: WebGLSampler;
  private readonly lut: WebGLTexture;
  private readonly cursor: WebGLTexture;
  private readonly uniforms: Uniforms;
  private lutVersion = -1;
  private cursorImage: Uint8ClampedArray | null = null;
  private cursorRect: [number, number, number, number] = [0, 0, 0, 0];
  /** The CRTC's last frame before the stage (GL row order), kept so a new
   *  LUT or cursor can be shown when the guest presents nothing more, and
   *  the frame restored when the stage ends. */
  private frame: (StageTarget & { opaque: boolean; encoding: ScanoutEncoding }) | null = null;
  private output: StageTarget | null = null;
  /** The LUT and cursor versions the last present showed; "" for none. */
  shown = "";

  private constructor(readonly gl: WebGL2RenderingContext) {
    const objects: Array<() => void> = [];
    try {
      this.program = compileProgram(gl, KMS_COLOR_STAGE_VS, KMS_COLOR_STAGE_FS);
      objects.push(() => gl.deleteProgram(this.program));
      const vao = gl.createVertexArray();
      const sampler = gl.createSampler();
      const lut = gl.createTexture();
      const cursor = gl.createTexture();
      objects.push(() => { gl.deleteVertexArray(vao); gl.deleteSampler(sampler); gl.deleteTexture(lut); gl.deleteTexture(cursor); });
      if (!vao || !sampler || !lut || !cursor) throw new Error("KMS color stage: object allocation failed");
      this.vao = vao; this.sampler = sampler; this.lut = lut; this.cursor = cursor;
      gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const at = (name: string) => gl.getUniformLocation(this.program, name);
      this.uniforms = {
        size: at("u_size"), cursorRect: at("u_cursor_rect"), frameTopFirst: at("u_frame_top_first"),
        targetTopFirst: at("u_target_top_first"), bgr: at("u_bgr"), encoding: at("u_encoding"),
        opaque: at("u_opaque"), lutEnabled: at("u_lut_enabled"),
      };
      gl.useProgram(this.program);
      gl.uniform1i(at("u_frame"), FRAME_UNIT);
      gl.uniform1i(at("u_lut"), LUT_UNIT);
      gl.uniform1i(at("u_cursor"), CURSOR_UNIT);
      // An empty cursor texture is still complete under the stage sampler.
      gl.activeTexture(gl.TEXTURE0 + CURSOR_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, cursor);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    } catch (error) {
      for (const release of objects) release();
      throw error;
    }
  }

  /** Build the stage on `gl`. Caller holds the generic presentation scope.
   *  Throws when the context cannot provide it: a CRTC with a LUT must not
   *  be shown without it. */
  static create(gl: WebGL2RenderingContext): KmsColorStage {
    resetKmsGlState(gl);
    return new KmsColorStage(gl);
  }

  /** Whether the stage's objects still belong to a live context (a lost and
   *  restored context invalidates every object made before the loss). */
  usable(gl: WebGL2RenderingContext): boolean {
    return this.gl === gl && !gl.isContextLost() && gl.isProgram(this.program);
  }

  /** The key of the stage state a present with `gamma` and `cursor` shows. */
  static key(gamma: KmsGamma | null, cursor: KmsCursor | null): string {
    return gamma ? `${gamma.version}:${cursor?.version ?? -1}` : "";
  }

  /** Copy `width` x `height` pixels of `read` (null: the default
   *  framebuffer's back buffer) at (`x`, `y`) into the retained frame, in GL
   *  row order. `topFirst`: the source's row `y` is the CRTC's top row (a
   *  KMS buffer), so the copy flips it. */
  capture(read: WebGLFramebuffer | null, x: number, y: number, width: number, height: number,
      topFirst: boolean, opaque: boolean, internalFormat = RGBA8): void {
    const gl = this.gl;
    if (![x, y, width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0)
      throw new RangeError(`Invalid KMS color stage frame ${width}x${height}+${x}+${y}`);
    // Any other normalized source blits exactly into RGBA8.
    const storage = FRAME_STORAGE[internalFormat] ? internalFormat : RGBA8;
    let frame = this.frame;
    if (!frame || frame.width !== width || frame.height !== height || frame.internalFormat !== storage) {
      frame = this.frame = { ...this.target(frame, width, height, storage), opaque,
        encoding: FRAME_STORAGE[storage].encoding };
    }
    frame.opaque = opaque;
    resetKmsGlState(gl);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    let readBuffer: number = gl.BACK;
    if (read === null) {
      // A session drawing straight to the canvas may have selected another
      // default read buffer; the frame is its back buffer.
      readBuffer = Number(gl.getParameter(gl.READ_BUFFER));
      if (readBuffer !== gl.BACK) gl.readBuffer(gl.BACK);
    }
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frame.fbo);
    gl.blitFramebuffer(x, y, x + width, y + height,
      0, topFirst ? height : 0, width, topFirst ? 0 : height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (read === null && readBuffer !== gl.BACK) gl.readBuffer(readBuffer);
  }

  /** Whether a frame has been captured. */
  get hasFrame(): boolean { return this.frame !== null; }

  /** Draw the retained frame onto the default framebuffer through the stage
   *  (`gamma` null: as captured, which restores it when the stage ends). */
  present(gamma: KmsGamma | null, cursor: KmsCursor | null): void {
    const frame = this.frame;
    if (!frame) throw new Error("KMS color stage has no frame");
    this.draw({ texture: frame.texture, topFirst: false, bgr: false, encoding: frame.encoding, opaque: frame.opaque },
      frame.width, frame.height, null, false, gamma, cursor);
    this.shown = KmsColorStage.key(gamma, cursor);
  }

  /** Render `source` through the stage into a stage-owned `width` x
   *  `height` texture whose row zero is the CRTC's top row, for a presenter
   *  that scales the CRTC output (the scanout presenter's mip chain). */
  render(source: KmsColorStageSource, width: number, height: number,
      gamma: KmsGamma | null, cursor: KmsCursor | null): WebGLTexture {
    const output = this.output = this.target(this.output, width, height);
    this.draw(source, width, height, output.fbo, true, gamma, cursor);
    this.shown = KmsColorStage.key(gamma, cursor);
    return output.texture;
  }

  /** Delete the stage's objects. The context lives on. */
  release(): void {
    const gl = this.gl;
    for (const target of [this.frame, this.output]) if (target) {
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.texture);
    }
    this.frame = this.output = null;
    gl.deleteTexture(this.lut);
    gl.deleteTexture(this.cursor);
    gl.deleteSampler(this.sampler);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.program);
  }

  /** A render target of the given size and storage (RGBA8 by default),
   *  reusing `existing` when it already matches. */
  private target(existing: StageTarget | null, width: number, height: number, internalFormat = RGBA8): StageTarget {
    const gl = this.gl;
    if (existing && existing.width === width && existing.height === height
        && existing.internalFormat === internalFormat) return existing;
    if (existing) {
      gl.deleteFramebuffer(existing.fbo);
      gl.deleteTexture(existing.texture);
    }
    const texture = gl.createTexture(), fbo = gl.createFramebuffer();
    if (!texture || !fbo) {
      gl.deleteTexture(texture); gl.deleteFramebuffer(fbo);
      throw new Error("KMS color stage: render target allocation failed");
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    const { format, type } = FRAME_STORAGE[internalFormat];
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo); gl.deleteTexture(texture);
      throw new Error("KMS color stage: render target incomplete");
    }
    return { texture, fbo, width, height, internalFormat };
  }

  /** Upload the LUT (once per table version) and the cursor image (once per
   *  image; a move changes only its rectangle). */
  private load(gamma: KmsGamma | null, cursor: KmsCursor | null): void {
    const gl = this.gl;
    if (gamma && gamma.version !== this.lutVersion) {
      const rgba = new Uint8Array(1024);
      for (let i = 0; i < 256; i++) {
        rgba[i * 4] = gamma.table[i];
        rgba[i * 4 + 1] = gamma.table[256 + i];
        rgba[i * 4 + 2] = gamma.table[512 + i];
        rgba[i * 4 + 3] = 255;
      }
      gl.activeTexture(gl.TEXTURE0 + LUT_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      this.lutVersion = gamma.version;
    }
    const image = gamma && cursor?.premultiplied && cursor.width > 0 && cursor.height > 0
      ? cursor.premultiplied : null;
    if (image && image !== this.cursorImage) {
      if (image.byteLength !== cursor!.width * cursor!.height * 4)
        throw new RangeError("KMS cursor image does not match its size");
      gl.activeTexture(gl.TEXTURE0 + CURSOR_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, this.cursor);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cursor!.width, cursor!.height, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(image.buffer, image.byteOffset, image.byteLength));
      this.cursorImage = image;
    }
    this.cursorRect = image ? [cursor!.x, cursor!.y, cursor!.width, cursor!.height] : [0, 0, 0, 0];
  }

  private draw(source: KmsColorStageSource, width: number, height: number,
      target: WebGLFramebuffer | null, targetTopFirst: boolean,
      gamma: KmsGamma | null, cursor: KmsCursor | null): void {
    const gl = this.gl, u = this.uniforms;
    resetKmsGlState(gl);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.load(gamma, cursor);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    for (const [unit, texture] of [[FRAME_UNIT, source.texture], [LUT_UNIT, this.lut], [CURSOR_UNIT, this.cursor]] as const) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindSampler(unit, this.sampler);
    }
    gl.uniform2i(u.size, width, height);
    gl.uniform4i(u.cursorRect, ...this.cursorRect);
    gl.uniform1i(u.frameTopFirst, source.topFirst ? 1 : 0);
    gl.uniform1i(u.targetTopFirst, targetTopFirst ? 1 : 0);
    gl.uniform1i(u.bgr, source.bgr ? 1 : 0);
    gl.uniform1i(u.encoding, source.encoding);
    gl.uniform1i(u.opaque, source.opaque ? 1 : 0);
    gl.uniform1i(u.lutEnabled, gamma ? 1 : 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // The guest's replay restores texture bindings but not sampler objects
    // (GLES 2 has none), so the stage leaves every unit without one.
    for (const unit of [FRAME_UNIT, LUT_UNIT, CURSOR_UNIT]) gl.bindSampler(unit, null);
    gl.activeTexture(gl.TEXTURE0);
  }
}
