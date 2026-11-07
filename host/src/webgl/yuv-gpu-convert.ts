/**
 * YCbCr to RGB conversion on the GPU, for a YUV dma-buf image with planes
 * in GPU-tier storage (an R8 luma texture, an RG8 or R8 chroma texture: a
 * GBM GPU buffer or an exported GLES image). Their pixels never leave the
 * GPU: each plane is copied into a private staging texture only when its
 * storage's write count (image-writes.ts) changed, and a fragment shader
 * converts the staged planes into the image's RGBA8 storage
 * (cpu-image-storage.ts), so an image whose planes nothing wrote costs no
 * GPU work at all.
 *
 * The shader computes exactly what the CPU converter (yuv-convert.ts) does
 * for the 8-bit formats, the only ones with GPU-tier planes (DRM_FORMAT_R8
 * and DRM_FORMAT_GR88 storage; P010's 16-bit planes and the packed formats
 * have no GPU storage):
 * - every sample is recovered as its 8-bit value, floor(t * 255 + 0.5);
 * - chroma is interpolated bilinearly between the samples around each
 *   pixel, chroma sample j sitting at luma position j * sub + siting *
 *   (sub - 1), edge samples repeated;
 * - Y, Cb and Cr are normalized by the range's offset and scale, R'G'B'
 *   follow from Kr and Kb, are clamped to [0, 1] and rounded to 8 bits
 *   before they are written, so the 8-bit target stores them exactly.
 *
 * Staging copies decouple the shader from the planes' own texture state:
 * an exported image may be a renderbuffer, a cube face or a mip level, and
 * its owner's filter may name mipmaps it never made (texelFetch of an
 * incomplete texture reads zero).
 *
 * Callers hold a private native pass (kernel.ts): the converter selects its
 * own program, vertex array, textures, samplers, framebuffers and
 * fixed-function state, and the guest's logical context is replayed in full
 * before its next command. Every native error raised in the pass is a fatal
 * host fault.
 */
import { resetKmsGlState } from "./kms-color-stage.js";
import {
  DRM_FORMAT_NV12, DRM_FORMAT_NV21, DRM_FORMAT_YUV420, DRM_FORMAT_YVU420, drmFormatInfo, planeHeight, planeWidth,
} from "./drm-format-info.js";
import type { YuvColorSpace } from "./yuv-convert.js";

/** Kr, Kb of BT.601, BT.709 and BT.2020 (as yuv-convert.ts). */
const COEFFICIENTS: readonly (readonly [number, number])[] = [[0.299, 0.114], [0.2126, 0.0722], [0.2627, 0.0593]];
const LUMA_UNIT = 0, CB_UNIT = 1, CR_UNIT = 2;

// Fullscreen triangle from gl_VertexID; fragments address texels from
// gl_FragCoord, so there are no attributes or varyings.
const YUV_VS = `#version 300 es
void main() {
  vec2 pos = vec2(float((gl_VertexID & 1) << 2) - 1.0,
                  float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(pos, 0.0, 1.0);
}
`;

const YUV_FS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D u_luma;
uniform highp sampler2D u_cb;
uniform highp sampler2D u_cr;
uniform ivec2 u_channels;
uniform ivec2 u_chroma;
uniform vec2 u_sub;
uniform vec2 u_origin;
uniform vec4 u_range;
uniform vec2 u_k;
out vec4 o_color;
float sample8(highp sampler2D plane, ivec2 at, int channel) {
  vec4 t = texelFetch(plane, at, 0);
  return floor((channel == 0 ? t.r : t.g) * 255.0 + 0.5);
}
float chroma(highp sampler2D plane, int channel, ivec2 i, ivec2 j, vec2 f) {
  float a = sample8(plane, ivec2(i.x, j.x), channel), b = sample8(plane, ivec2(i.y, j.x), channel);
  float c = sample8(plane, ivec2(i.x, j.y), channel), d = sample8(plane, ivec2(i.y, j.y), channel);
  return (a * (1.0 - f.x) + b * f.x) * (1.0 - f.y) + (c * (1.0 - f.x) + d * f.x) * f.y;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 u = (vec2(p) - u_origin) / u_sub;
  vec2 base = floor(u);
  vec2 f = u - base;
  ivec2 first = ivec2(base);
  ivec2 i = clamp(ivec2(first.x, first.x + 1), 0, u_chroma.x - 1);
  ivec2 j = clamp(ivec2(first.y, first.y + 1), 0, u_chroma.y - 1);
  float y = (sample8(u_luma, p, 0) - u_range.x) / u_range.y;
  float pb = (chroma(u_cb, u_channels.x, i, j, f) - u_range.z) / u_range.w;
  float pr = (chroma(u_cr, u_channels.y, i, j, f) - u_range.z) / u_range.w;
  float r = y + 2.0 * (1.0 - u_k.x) * pr;
  float b = y + 2.0 * (1.0 - u_k.y) * pb;
  float g = (y - u_k.x * r - u_k.y * b) / (1.0 - u_k.x - u_k.y);
  o_color = vec4(floor(clamp(vec3(r, g, b), 0.0, 1.0) * 255.0 + 0.5) / 255.0, 1.0);
}
`;

export type YuvGpuConversion = { colorSpace: YuvColorSpace; fullRange: boolean; sitingH: 0 | 0.5; sitingV: 0 | 0.5 };

/** The uniforms that make the shader convert `format` as the CPU
 * converter does: which staged plane and channel holds Cb and Cr, the
 * chroma grid, its siting, the range in 8-bit sample units, Kr and Kb. */
export function yuvGpuUniforms(format: number, width: number, height: number, conversion: YuvGpuConversion) {
  format >>>= 0;
  const info = drmFormatInfo(format);
  if (!info?.isYuv || !yuvGpuFormat(format)) throw new RangeError(`No GPU conversion for format ${format}`);
  const semiPlanar = format === DRM_FORMAT_NV12 || format === DRM_FORMAT_NV21;
  // Planes holding Cb and Cr, and their channels (0 red, 1 green).
  const planes: [number, number] = semiPlanar ? [1, 1] : format === DRM_FORMAT_YUV420 ? [1, 2] : [2, 1];
  const channels: [number, number] = format === DRM_FORMAT_NV21 ? [1, 0] : semiPlanar ? [0, 1] : [0, 0];
  const [kr, kb] = COEFFICIENTS[conversion.colorSpace];
  const full = conversion.fullRange;
  return {
    planes, channels,
    chroma: [planeWidth(info, width, 1), planeHeight(info, height, 1)] as [number, number],
    sub: [info.hsub, info.vsub] as [number, number],
    origin: [conversion.sitingH * (info.hsub - 1), conversion.sitingV * (info.vsub - 1)] as [number, number],
    range: [full ? 0 : 16, full ? 255 : 219, 128, full ? 255 : 224] as [number, number, number, number],
    k: [kr, kb] as [number, number],
  };
}

/** Formats whose planes may be GPU-tier storage, and so converted here. */
export function yuvGpuFormat(format: number): boolean {
  format >>>= 0;
  return format === DRM_FORMAT_NV12 || format === DRM_FORMAT_NV21 || format === DRM_FORMAT_YUV420
    || format === DRM_FORMAT_YVU420;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("YUV conversion: shader allocation failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`YUV conversion: shader compile failed: ${log}`);
  }
  return shader;
}

type Uniforms = Record<"channels" | "chroma" | "sub" | "origin" | "range" | "k", WebGLUniformLocation | null>;

/** The conversion program on one WebGL2 context, made on first use and
 * kept for the context's life (one program, vertex array and sampler). */
export class YuvGpuConverter {
  private static readonly converters = new WeakMap<WebGL2RenderingContext, YuvGpuConverter>();
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  /** NEAREST, non-mipmapped sampling: staging textures are complete under
   *  it whatever their own parameters. */
  private readonly sampler: WebGLSampler;
  private readonly uniforms: Uniforms;

  /** The converter of `gl`. Caller holds a private native pass. Throws when
   *  the context cannot build it. */
  static for(gl: WebGL2RenderingContext): YuvGpuConverter {
    const existing = YuvGpuConverter.converters.get(gl);
    if (existing && gl.isProgram(existing.program)) return existing;
    const converter = new YuvGpuConverter(gl);
    YuvGpuConverter.converters.set(gl, converter);
    return converter;
  }

  private constructor(private readonly gl: WebGL2RenderingContext) {
    resetKmsGlState(gl);
    const vs = compile(gl, gl.VERTEX_SHADER, YUV_VS);
    let fs: WebGLShader;
    try { fs = compile(gl, gl.FRAGMENT_SHADER, YUV_FS); }
    catch (error) { gl.deleteShader(vs); throw error; }
    const program = gl.createProgram();
    if (program) { gl.attachShader(program, vs); gl.attachShader(program, fs); gl.linkProgram(program); }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!program) throw new Error("YUV conversion: program allocation failed");
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`YUV conversion: program link failed: ${log}`);
    }
    const vao = gl.createVertexArray(), sampler = gl.createSampler();
    if (!vao || !sampler) {
      gl.deleteProgram(program); gl.deleteVertexArray(vao); gl.deleteSampler(sampler);
      throw new Error("YUV conversion: object allocation failed");
    }
    this.program = program; this.vao = vao; this.sampler = sampler;
    gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const at = (name: string) => gl.getUniformLocation(program, name);
    this.uniforms = { channels: at("u_channels"), chroma: at("u_chroma"), sub: at("u_sub"), origin: at("u_origin"),
      range: at("u_range"), k: at("u_k") };
    gl.useProgram(program);
    gl.uniform1i(at("u_luma"), LUMA_UNIT);
    gl.uniform1i(at("u_cb"), CB_UNIT);
    gl.uniform1i(at("u_cr"), CR_UNIT);
  }

  /** Copy the first `width` x `height` texels of a plane's storage (`read`,
   *  a framebuffer over it) into its staging texture's framebuffer. */
  copy(read: WebGLFramebuffer, staging: WebGLFramebuffer, width: number, height: number): void {
    const gl = this.gl;
    resetKmsGlState(gl);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, staging);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  /** Upload a CPU-tier plane's rows, tightly packed, into its staging
   *  texture (`format`: RED or RG). */
  upload(staging: WebGLTexture, width: number, height: number, format: number, rows: Uint8Array): void {
    const gl = this.gl;
    resetKmsGlState(gl);
    gl.bindTexture(gl.TEXTURE_2D, staging);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, format, gl.UNSIGNED_BYTE, rows);
  }

  /** Convert the staged planes (luma first) into `target`, a framebuffer
   *  over the image's `width` x `height` RGBA8 storage. */
  convert(target: WebGLFramebuffer, staged: readonly WebGLTexture[], format: number, width: number, height: number,
      conversion: YuvGpuConversion): void {
    const gl = this.gl, u = this.uniforms, values = yuvGpuUniforms(format, width, height, conversion);
    resetKmsGlState(gl);
    gl.disable(gl.DITHER);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    const sources = [staged[0], staged[values.planes[0]], staged[values.planes[1]]];
    for (const [unit, texture] of [[LUMA_UNIT, sources[0]], [CB_UNIT, sources[1]], [CR_UNIT, sources[2]]] as const) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindSampler(unit, this.sampler);
    }
    gl.uniform2i(u.channels, ...values.channels);
    gl.uniform2i(u.chroma, ...values.chroma);
    gl.uniform2f(u.sub, ...values.sub);
    gl.uniform2f(u.origin, ...values.origin);
    gl.uniform4f(u.range, ...values.range);
    gl.uniform2f(u.k, ...values.k);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // The guest's replay restores texture bindings but not sampler objects
    // (GLES 2 has none), so every unit is left without one.
    for (const unit of [LUMA_UNIT, CB_UNIT, CR_UNIT]) gl.bindSampler(unit, null);
    gl.activeTexture(gl.TEXTURE0);
  }
}

/** Staging storage of each plane of a GPU-converted format: its plane
 * format's texture (DRM_FORMAT_R8 or DRM_FORMAT_GR88). */
export function yuvGpuPlaneSize(format: number, width: number, height: number, plane: number): [number, number] {
  const info = drmFormatInfo(format)!;
  return [planeWidth(info, width, plane), planeHeight(info, height, plane)];
}
