/**
 * Synchronous GL query handler invoked by `host_gl_query`.
 *
 * Sync queries can't ride the cmdbuf — `glGetError`, `glGetUniformLocation`,
 * etc. need a reply *now*. The C side issues `ioctl(GLIO_QUERY)` with
 * `(op, in, out)` buffers; the kernel forwards the call to
 * `HostIO::gl_query`, which lands here.
 *
 * Returns the number of bytes written to `out`, or a negative errno-ish
 * value: `-EPERM` (-1) when the binding has no live context, `-EINVAL`
 * (-22) for an unknown query op.
 *
 * Uniform locations: WebGL hands back opaque `WebGLUniformLocation`
 * objects; the cmdbuf needs an integer. We allocate monotonic indices
 * via `++b.nextUniformLoc` (audit finding #12 — Map.size shrinks on
 * delete and would collide). Indices are number-keyed for clean u32
 * round-tripping.
 */
import type { GlBinding } from "./registry.js";
import * as O from "./ops.js";

const GL_VENDOR = 0x1F00;
const GL_RENDERER = 0x1F01;
const GL_VERSION = 0x1F02;
const GL_EXTENSIONS = 0x1F03;
const GL_VIEWPORT = 0x0BA2;
const GL_SCISSOR_BOX = 0x0C10;
const GL_SHADING_LANGUAGE_VERSION = 0x8B8C;
const GL_CURRENT_PROGRAM = 0x8B8D;
const GL_ACTIVE_UNIFORMS = 0x8B86;
const GL_ACTIVE_UNIFORM_MAX_LENGTH = 0x8B87;
const GL_INFO_LOG_LENGTH = 0x8B84;
const KANDELO_GLES_EXTENSIONS = [
  // WebGL2 can render to RGBA8 textures. Expose the equivalent GLES2
  // extension so native renderers do not fall back to lower-precision canvases.
  "GL_OES_rgb8_rgba8",
].join(" ");
const GL_UNSIGNED_SHORT = 0x1403;
const GL_UNSIGNED_INT = 0x1405;
const GL_FLOAT = 0x1406;
const GL_HALF_FLOAT = 0x140B;
const GL_UNSIGNED_SHORT_4_4_4_4 = 0x8033;
const GL_UNSIGNED_SHORT_5_5_5_1 = 0x8034;
const GL_UNSIGNED_SHORT_5_6_5 = 0x8363;
const GL_UNSIGNED_INT_2_10_10_10_REV = 0x8368;
const GL_UNSIGNED_INT_24_8 = 0x84FA;
const GL_UNSIGNED_INT_10F_11F_11F_REV = 0x8C3B;

function alignedFloat32View(out: Uint8Array): Float32Array {
  if (out.byteOffset % 4 === 0) {
    return new Float32Array(out.buffer, out.byteOffset, (out.byteLength / 4) | 0);
  }
  return new Float32Array((out.byteLength / 4) | 0);
}

function alignedUint32View(out: Uint8Array): Uint32Array {
  if (out.byteOffset % 4 === 0) {
    return new Uint32Array(out.buffer, out.byteOffset, (out.byteLength / 4) | 0);
  }
  return new Uint32Array((out.byteLength / 4) | 0);
}

function alignedUint16View(out: Uint8Array): Uint16Array {
  if (out.byteOffset % 2 === 0) {
    return new Uint16Array(out.buffer, out.byteOffset, (out.byteLength / 2) | 0);
  }
  return new Uint16Array((out.byteLength / 2) | 0);
}

function readPixelsViewForType(type: number, out: Uint8Array): ArrayBufferView {
  switch (type) {
    case GL_FLOAT:
      return alignedFloat32View(out);
    case GL_UNSIGNED_SHORT:
    case GL_HALF_FLOAT:
    case GL_UNSIGNED_SHORT_4_4_4_4:
    case GL_UNSIGNED_SHORT_5_5_5_1:
    case GL_UNSIGNED_SHORT_5_6_5:
      return alignedUint16View(out);
    case GL_UNSIGNED_INT:
    case GL_UNSIGNED_INT_2_10_10_10_REV:
    case GL_UNSIGNED_INT_24_8:
    case GL_UNSIGNED_INT_10F_11F_11F_REV:
      return alignedUint32View(out);
    default:
      return out;
  }
}

function copyReadPixelsResult(view: ArrayBufferView, out: Uint8Array): void {
  if (view.buffer === out.buffer && view.byteOffset === out.byteOffset) return;
  const bytes = new Uint8Array(view.buffer, view.byteOffset, Math.min(view.byteLength, out.byteLength));
  out.set(bytes);
}

export function runGlQuery(
  b: GlBinding,
  op: number,
  input: Uint8Array,
  out: Uint8Array,
): number {
  if (!b.gl) return -1;
  const gl = b.gl;
  const inDv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outDv = new DataView(out.buffer, out.byteOffset, out.byteLength);

  switch (op) {
    case O.QOP_GET_ERROR:
      if (out.byteLength < 4) return -22;
      outDv.setUint32(0, gl.getError(), true);
      return 4;

    // in: u32 name; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_STRING: {
      if (input.byteLength < 4) return -22;
      const name = inDv.getUint32(0, true);
      let s = "";
      switch (name) {
        case GL_VENDOR:
          s = "Kandelo";
          break;
        case GL_RENDERER:
          s = "Kandelo WebGL GLES bridge";
          break;
        case GL_VERSION:
          // GLAD's GLES parser expects this exact native-style prefix.
          s = "OpenGL ES 2.0 Kandelo";
          break;
        case GL_SHADING_LANGUAGE_VERSION:
          s = "OpenGL ES GLSL ES 1.00 Kandelo";
          break;
        case GL_EXTENSIONS:
          s = KANDELO_GLES_EXTENSIONS;
          break;
        default:
          s = (gl.getParameter(name) as string | null) ?? "";
          break;
      }
      return writeLengthPrefixedString(out, outDv, s);
    }

    // in: u32 pname; out: i32 value(s)
    case O.QOP_GET_INTEGERV: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const pname = inDv.getUint32(0, true);
      if (pname === GL_CURRENT_PROGRAM) {
        outDv.setInt32(0, nameForObject(b.programs, b.currentProgram), true);
        return 4;
      }
      if (pname === GL_VIEWPORT) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.viewport, false, pname);
      }
      if (pname === GL_SCISSOR_BOX) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.scissor.rect, false, pname);
      }
      const value = gl.getParameter(pname);
      return writeNumericValues(outDv, out.byteLength, value, false, pname);
    }

    // in: u32 pname; out: f32 value(s)
    case O.QOP_GET_FLOATV: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const pname = inDv.getUint32(0, true);
      if (pname === GL_VIEWPORT) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.viewport, true, pname);
      }
      if (pname === GL_SCISSOR_BOX) {
        return writeNumericValues(outDv, out.byteLength, b.shadow.scissor.rect, true, pname);
      }
      const value = gl.getParameter(pname);
      return writeNumericValues(outDv, out.byteLength, value, true, pname);
    }

    // in: u32 program, u32 nameLen, u8 name[nameLen]; out: i32 location-index
    case O.QOP_GET_UNIFORM_LOC: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const programName = inDv.getUint32(0, true);
      const nameLen = inDv.getUint32(4, true);
      if (input.byteLength < 8 + nameLen) return -22;
      const program = b.programs.get(programName);
      const uniformName = new TextDecoder().decode(input.subarray(8, 8 + nameLen));
      const loc = program ? gl.getUniformLocation(program, uniformName) : null;
      if (loc) {
        const idx = ++b.nextUniformLoc;
        b.uniformLocations.set(idx, loc);
        outDv.setInt32(0, idx, true);
      } else {
        outDv.setInt32(0, -1, true);
      }
      return 4;
    }

    // in: u32 program, u32 nameLen, u8 name[nameLen]; out: i32 attrib-index
    case O.QOP_GET_ATTRIB_LOC: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const programName = inDv.getUint32(0, true);
      const nameLen = inDv.getUint32(4, true);
      if (input.byteLength < 8 + nameLen) return -22;
      const program = b.programs.get(programName);
      const attrName = new TextDecoder().decode(input.subarray(8, 8 + nameLen));
      const loc = program ? gl.getAttribLocation(program, attrName) : -1;
      outDv.setInt32(0, loc, true);
      return 4;
    }

    // in: u32 shaderName, u32 pname; out: i32 value
    case O.QOP_GET_SHADERIV: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const sh = b.shaders.get(inDv.getUint32(0, true));
      if (!sh) {
        outDv.setInt32(0, 0, true);
        return 4;
      }
      const pname = inDv.getUint32(4, true);
      const v = pname === GL_INFO_LOG_LENGTH
        ? ((gl.getShaderInfoLog(sh) ?? "").length + 1)
        : gl.getShaderParameter(sh, pname);
      outDv.setInt32(0, typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0), true);
      return 4;
    }

    // in: u32 shaderName; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_SHADER_INFO_LOG: {
      if (input.byteLength < 4) return -22;
      const sh = b.shaders.get(inDv.getUint32(0, true));
      const log = (sh && gl.getShaderInfoLog(sh)) ?? "";
      const bytes = new TextEncoder().encode(log);
      const need = 4 + bytes.byteLength;
      if (out.byteLength < need) {
        outDv.setUint32(0, 0, true);
        return 4;
      }
      outDv.setUint32(0, bytes.byteLength, true);
      out.set(bytes, 4);
      return need;
    }

    // in: u32 programName, u32 pname; out: i32 value
    case O.QOP_GET_PROGRAMIV: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      if (!prog) {
        outDv.setInt32(0, 0, true);
        return 4;
      }
      const pname = inDv.getUint32(4, true);
      let v: unknown;
      if (pname === GL_INFO_LOG_LENGTH) {
        v = (gl.getProgramInfoLog(prog) ?? "").length + 1;
      } else if (pname === GL_ACTIVE_UNIFORM_MAX_LENGTH) {
        const n = Number(gl.getProgramParameter(prog, GL_ACTIVE_UNIFORMS) ?? 0);
        let max = 0;
        for (let i = 0; i < n; i++) {
          const info = gl.getActiveUniform(prog, i);
          if (info) max = Math.max(max, info.name.length + 1);
        }
        v = max;
      } else {
        v = gl.getProgramParameter(prog, pname);
      }
      outDv.setInt32(0, typeof v === "boolean" ? (v ? 1 : 0) : Number(v ?? 0), true);
      return 4;
    }

    // in: u32 programName; out: u32 strLen, u8 str[strLen]
    case O.QOP_GET_PROGRAM_INFO_LOG: {
      if (input.byteLength < 4) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      const log = (prog && gl.getProgramInfoLog(prog)) ?? "";
      const bytes = new TextEncoder().encode(log);
      const need = 4 + bytes.byteLength;
      if (out.byteLength < need) {
        outDv.setUint32(0, 0, true);
        return 4;
      }
      outDv.setUint32(0, bytes.byteLength, true);
      out.set(bytes, 4);
      return need;
    }

    // in: i32 x, i32 y, i32 w, i32 h, u32 format, u32 type; out: u8 pixels[...]
    case O.QOP_READ_PIXELS: {
      if (input.byteLength < 24) return -22;
      const x = inDv.getInt32(0, true);
      const y = inDv.getInt32(4, true);
      const w = inDv.getInt32(8, true);
      const h = inDv.getInt32(12, true);
      const format = inDv.getUint32(16, true);
      const type = inDv.getUint32(20, true);
      // WebGL2 readPixels requires the destination view to match `type`.
      const view = readPixelsViewForType(type, out);
      gl.readPixels(x, y, w, h, format, type, view);
      copyReadPixelsResult(view, out);
      // gl.readPixels writes into `out` directly. Bytes-written depends
      // on (format,type,w,h); the kernel cap (`MAX_QUERY_OUT_LEN`) is
      // the upper bound. Return the full out length — the C side knows
      // the geometry.
      return out.byteLength;
    }

    // in: u32 target; out: u32 status
    case O.QOP_CHECK_FB_STATUS: {
      if (input.byteLength < 4 || out.byteLength < 4) return -22;
      const status = gl.checkFramebufferStatus(inDv.getUint32(0, true));
      outDv.setUint32(0, status, true);
      return 4;
    }

    // in: u32 programName, u32 uniformIndex, u32 nameCapacity;
    // out: u32 nameLen, i32 size, u32 type, u8 name[nameLen]
    case O.QOP_GET_ACTIVE_UNIFORM: {
      if (input.byteLength < 12 || out.byteLength < 12) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      const index = inDv.getUint32(4, true);
      const cap = inDv.getUint32(8, true);
      const info = prog ? gl.getActiveUniform(prog, index) : null;
      if (!info) {
        outDv.setUint32(0, 0, true);
        outDv.setInt32(4, 0, true);
        outDv.setUint32(8, 0, true);
        return 12;
      }
      const nameBytes = new TextEncoder().encode(info.name);
      const nameLen = Math.min(nameBytes.byteLength, cap, out.byteLength - 12);
      outDv.setUint32(0, nameLen, true);
      outDv.setInt32(4, info.size, true);
      outDv.setUint32(8, info.type, true);
      out.set(nameBytes.subarray(0, nameLen), 12);
      return 12 + nameLen;
    }

    // in: u32 programName, i32 locationIndex; out: f32 values[]
    case O.QOP_GET_UNIFORMFV:
    case O.QOP_GET_UNIFORMIV: {
      if (input.byteLength < 8 || out.byteLength < 4) return -22;
      const prog = b.programs.get(inDv.getUint32(0, true));
      const loc = b.uniformLocations.get(inDv.getInt32(4, true)) ?? null;
      const value = prog && loc ? gl.getUniform(prog, loc) : null;
      return writeNumericValues(outDv, out.byteLength, value, op === O.QOP_GET_UNIFORMFV, 0);
    }

    default:
      return -22;
  }
}

function nameForObject<T>(objects: Map<number, T>, object: T | null): number {
  if (!object) return 0;
  for (const [name, candidate] of objects) {
    if (candidate === object) return name;
  }
  return 0;
}

function writeLengthPrefixedString(
  out: Uint8Array,
  outDv: DataView,
  value: string,
): number {
  const bytes = new TextEncoder().encode(value);
  const need = 4 + bytes.byteLength;
  if (out.byteLength < need) return -22;
  outDv.setUint32(0, bytes.byteLength, true);
  out.set(bytes, 4);
  return need;
}

function writeNumericValues(
  outDv: DataView,
  outLen: number,
  value: unknown,
  asFloat: boolean,
  pname: number,
): number {
  const values = normalizeNumericValues(value, pname);
  const count = Math.min(values.length, Math.floor(outLen / 4));
  for (let i = 0; i < count; i++) {
    if (asFloat) outDv.setFloat32(i * 4, values[i], true);
    else outDv.setInt32(i * 4, values[i] | 0, true);
  }
  return count * 4;
}

function normalizeNumericValues(value: unknown, pname: number): number[] {
  if (value == null) {
    if (pname === GL_VIEWPORT || pname === GL_SCISSOR_BOX) return [0, 0, 0, 0];
    return [0];
  }
  if (typeof value === "boolean") return [value ? 1 : 0];
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.map(Number);
  if (ArrayBuffer.isView(value)) return Array.from(value as ArrayLike<number>, Number);
  return [Number(value) || 0];
}
