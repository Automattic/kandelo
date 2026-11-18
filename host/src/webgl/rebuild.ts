/**
 * Turn a captured GL session back into the commands that made it.
 *
 * The inverse of `webgl/snapshot.ts`. A restored guest resumes believing
 * its GL objects exist, and its next cmdbuf names them. Rather than create
 * WebGL objects behind the bridge's back, the rebuild writes the GLES 2
 * command stream a guest would have sent to reach the captured state, and
 * the kernel submits it through the ordinary path: the bridge then builds
 * every record it keeps about the guest (buffer stores, texture levels,
 * uniform layouts, vertex arrays, framebuffer attachments, the shadow)
 * exactly as it does for a live guest.
 *
 * The stream comes in three parts, because a program's uniform numbering
 * must be seeded (`seedUniformTemplate`) after the program object exists
 * and before it links, and a program journal pins programs by name:
 *
 *   1. `objects`: buffers with their bytes, textures with their texels,
 *      renderbuffer storage, shaders compiled from the guest's own source,
 *      programs with their shaders attached and attribute locations bound.
 *   2. `state`: links and uniform values, the sampler parameters of
 *      foreign textures, vertex arrays, framebuffer attachments,
 *      delete-pending shaders, then every context value and binding the
 *      guest set.
 *   3. `deletions`: delete-pending programs, once the kernel has restored
 *      the program journal that may still pin them.
 *
 * Foreign textures have no GLES 2 command: between the two parts the
 * kernel binds them to their GBM buffers through the ioctl's own path.
 */
import * as O from "./ops.js";
import type { CheckpointGlForeignTexture, CheckpointGlSession, CheckpointGlState, CheckpointGlTexture } from "./snapshot.js";

const GL_TEXTURE_2D = 0x0de1;
const GL_ARRAY_BUFFER = 0x8892;
const GL_ELEMENT_ARRAY_BUFFER = 0x8893;
const GL_TEXTURE0 = 0x84c0;
const GL_FRAMEBUFFER = 0x8d40;
const GL_RENDERBUFFER = 0x8d41;
const GL_UNPACK_ALIGNMENT = 0x0cf5;
const GL_PACK_ALIGNMENT = 0x0d05;
const GL_TEXTURE_MAG_FILTER = 0x2800;
const GL_TEXTURE_MIN_FILTER = 0x2801;
const GL_TEXTURE_WRAP_S = 0x2802;
const GL_TEXTURE_WRAP_T = 0x2803;
const GL_HALF_FLOAT = 0x140b;
const GL_HALF_FLOAT_OES = 0x8d61;

/** The longest payload a record can carry (its length is a u16). */
export const MAX_RECORD_PAYLOAD = 0xffff;
/** Commands per submitted frame stay inside one guest cmdbuf's size. */
const FRAME_BYTES = 1 << 20;

const UNIFORM_SETTERS = new Map<number, { op: number; width: number; float: boolean; matrix?: boolean }>([
  [0x1406, { op: O.OP_UNIFORM1FV, width: 1, float: true }],
  [0x8b50, { op: O.OP_UNIFORM2FV, width: 2, float: true }],
  [0x8b51, { op: O.OP_UNIFORM3FV, width: 3, float: true }],
  [0x8b52, { op: O.OP_UNIFORM4FV, width: 4, float: true }],
  [0x1404, { op: O.OP_UNIFORM1IV, width: 1, float: false }],
  [0x8b53, { op: O.OP_UNIFORM2IV, width: 2, float: false }],
  [0x8b54, { op: O.OP_UNIFORM3IV, width: 3, float: false }],
  [0x8b55, { op: O.OP_UNIFORM4IV, width: 4, float: false }],
  [0x8b56, { op: O.OP_UNIFORM1IV, width: 1, float: false }],
  [0x8b57, { op: O.OP_UNIFORM2IV, width: 2, float: false }],
  [0x8b58, { op: O.OP_UNIFORM3IV, width: 3, float: false }],
  [0x8b59, { op: O.OP_UNIFORM4IV, width: 4, float: false }],
  [0x8b5e, { op: O.OP_UNIFORM1IV, width: 1, float: false }],
  [0x8b60, { op: O.OP_UNIFORM1IV, width: 1, float: false }],
  [0x8b5a, { op: O.OP_UNIFORM_MATRIX2FV, width: 4, float: true, matrix: true }],
  [0x8b5b, { op: O.OP_UNIFORM_MATRIX3FV, width: 9, float: true, matrix: true }],
  [0x8b5c, { op: O.OP_UNIFORM_MATRIX4FV, width: 16, float: true, matrix: true }],
]);

/** True when the rebuild has a setter for a uniform of this native type. */
export function uniformTypeCarried(type: number): boolean {
  return UNIFORM_SETTERS.has(type);
}

/** Packs records (u16 op, u16 length, payload) into whole frames. */
class CommandWriter {
  readonly frames: Uint8Array[] = [];
  #bytes = new Uint8Array(FRAME_BYTES);
  #view = new DataView(this.#bytes.buffer);
  #length = 0;

  /** One record whose payload holds `words` (u32, i32 or f32) then `tail`. */
  record(op: number, words: readonly (readonly ["u" | "i" | "f", number])[], tail?: Uint8Array): void {
    const payload = words.length * 4 + (tail?.byteLength ?? 0);
    if (payload > MAX_RECORD_PAYLOAD) throw new Error(`GL rebuild record 0x${op.toString(16)} is too long`);
    if (this.#length + 4 + payload > FRAME_BYTES) this.flush();
    const view = this.#view;
    view.setUint16(this.#length, op, true);
    view.setUint16(this.#length + 2, payload, true);
    let at = this.#length + 4;
    for (const [kind, value] of words) {
      if (kind === "u") view.setUint32(at, value >>> 0, true);
      else if (kind === "i") view.setInt32(at, value, true);
      else view.setFloat32(at, value, true);
      at += 4;
    }
    if (tail) this.#bytes.set(tail, at);
    this.#length += 4 + payload;
  }

  u(op: number, ...values: number[]): void {
    this.record(op, values.map((value) => ["u", value] as const));
  }

  flush(): void {
    if (this.#length === 0) return;
    this.frames.push(this.#bytes.slice(0, this.#length));
    this.#length = 0;
  }

  finish(): Uint8Array[] {
    this.flush();
    return this.frames;
  }
}

const utf8 = new TextEncoder();

function u32Array(op: number, names: readonly number[], writer: CommandWriter): void {
  if (names.length) writer.u(op, names.length, ...names);
}

/** Records that recreate every object the session names, up to linking. */
export function glObjectCommands(session: CheckpointGlSession): Uint8Array[] {
  const w = new CommandWriter();
  for (const buffer of session.buffers) {
    w.u(O.OP_BIND_BUFFER, buffer.target, buffer.name);
    w.u(O.OP_BUFFER_DATA, buffer.target, buffer.bytes.byteLength, buffer.usage);
    const chunk = MAX_RECORD_PAYLOAD - 12;
    for (let offset = 0; offset < buffer.bytes.byteLength; offset += chunk) {
      const bytes = buffer.bytes.subarray(offset, offset + chunk);
      w.record(O.OP_BUFFER_SUB_DATA, [["u", buffer.target], ["i", offset], ["u", bytes.byteLength]], bytes);
    }
    w.u(O.OP_BIND_BUFFER, buffer.target, 0);
  }

  w.u(O.OP_ACTIVE_TEXTURE, GL_TEXTURE0);
  w.u(O.OP_PIXEL_STOREI, GL_UNPACK_ALIGNMENT, 1);
  for (const texture of session.textures) textureCommands(texture, w);
  w.u(O.OP_BIND_TEXTURE, GL_TEXTURE_2D, 0);

  for (const renderbuffer of session.renderbuffers) {
    w.u(O.OP_BIND_RENDERBUFFER, GL_RENDERBUFFER, renderbuffer.name);
    if (renderbuffer.internalFormat !== 0) {
      w.u(O.OP_RENDERBUFFER_STORAGE, GL_RENDERBUFFER, renderbuffer.internalFormat,
        renderbuffer.width, renderbuffer.height);
    }
  }
  if (session.renderbuffers.length) w.u(O.OP_BIND_RENDERBUFFER, GL_RENDERBUFFER, 0);

  for (const shader of session.shaders) {
    w.u(O.OP_CREATE_SHADER, shader.type, shader.name);
    if (shader.source !== null) {
      w.record(O.OP_SHADER_SOURCE, [["u", shader.name], ["u", shader.source.byteLength]], shader.source);
    }
    if (shader.compiled) w.u(O.OP_COMPILE_SHADER, shader.name);
  }
  for (const program of session.programs) {
    w.u(O.OP_CREATE_PROGRAM, program.name);
    for (const shader of program.shaders) w.u(O.OP_ATTACH_SHADER, program.name, shader);
    for (const binding of program.attribBindings) {
      const name = utf8.encode(binding.name);
      w.record(O.OP_BIND_ATTRIB_LOCATION, [["u", program.name], ["u", binding.index], ["u", name.byteLength]], name);
    }
  }
  return w.finish();
}

function textureCommands(texture: CheckpointGlTexture, w: CommandWriter): void {
  w.u(O.OP_BIND_TEXTURE, GL_TEXTURE_2D, texture.name);
  for (const level of texture.levels) {
    // The bridge records HALF_FLOAT_OES as WebGL's HALF_FLOAT; the GLES 2
    // wire takes only the OES token.
    const type = level.type === GL_HALF_FLOAT ? GL_HALF_FLOAT_OES : level.type;
    w.record(O.OP_TEX_IMAGE_2D, [
      ["u", GL_TEXTURE_2D], ["i", level.level], ["i", level.internalFormat],
      ["i", level.width], ["i", level.height], ["i", 0],
      ["u", level.format], ["u", type], ["u", 0],
    ]);
    if (level.pixels === null || level.width === 0 || level.height === 0) continue;
    const texelBytes = level.pixels.byteLength / (level.width * level.height);
    const budget = MAX_RECORD_PAYLOAD - 36;
    // Whole rows when a row fits a record; otherwise spans of one row.
    const spanTexels = Math.min(level.width, Math.floor(budget / texelBytes));
    const rows = spanTexels === level.width ? Math.max(1, Math.floor(budget / (texelBytes * level.width))) : 1;
    for (let y = 0; y < level.height; y += rows) {
      const height = Math.min(rows, level.height - y);
      for (let x = 0; x < level.width; x += spanTexels) {
        const width = Math.min(spanTexels, level.width - x);
        const bytes = new Uint8Array(width * height * texelBytes);
        for (let row = 0; row < height; row++) {
          const from = ((y + row) * level.width + x) * texelBytes;
          bytes.set(level.pixels.subarray(from, from + width * texelBytes), row * width * texelBytes);
        }
        w.record(O.OP_TEX_SUB_IMAGE_2D, [
          ["u", GL_TEXTURE_2D], ["i", level.level], ["i", x], ["i", y],
          ["i", width], ["i", height], ["u", level.format], ["u", type], ["u", bytes.byteLength],
        ], bytes);
      }
    }
  }
  parameterCommands(texture, w);
}

function parameterCommands(texture: CheckpointGlTexture | CheckpointGlForeignTexture, w: CommandWriter): void {
  w.u(O.OP_TEX_PARAMETERI, GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, texture.minFilter);
  w.u(O.OP_TEX_PARAMETERI, GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, texture.magFilter);
  w.u(O.OP_TEX_PARAMETERI, GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, texture.wrapS);
  w.u(O.OP_TEX_PARAMETERI, GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, texture.wrapT);
}

/** Records that link, wire and set everything once objects exist. */
export function glStateCommands(session: CheckpointGlSession): Uint8Array[] {
  const w = new CommandWriter();
  for (const program of session.programs) {
    if (!program.linked) continue;
    w.u(O.OP_LINK_PROGRAM, program.name);
    if (!program.values.length) continue;
    w.u(O.OP_USE_PROGRAM, program.name);
    for (const value of program.values) {
      const setter = UNIFORM_SETTERS.get(value.type);
      if (!setter) throw new Error(`GL rebuild has no setter for uniform type 0x${value.type.toString(16)}`);
      const kind = setter.float ? "f" : "i";
      const data = value.values.slice(0, setter.width).map((element) => [kind, element] as const);
      w.record(setter.op, [
        ["i", value.location], ["u", 1], ...(setter.matrix ? [["u", 0] as const] : []), ...data,
      ]);
    }
  }
  for (const shader of session.shaders) if (shader.deletePending) w.u(O.OP_DELETE_SHADER, shader.name);

  if (session.foreignTextures.length) w.u(O.OP_ACTIVE_TEXTURE, GL_TEXTURE0);
  for (const texture of session.foreignTextures) {
    w.u(O.OP_BIND_TEXTURE, GL_TEXTURE_2D, texture.name);
    parameterCommands(texture, w);
  }
  if (session.foreignTextures.length) w.u(O.OP_BIND_TEXTURE, GL_TEXTURE_2D, 0);

  u32Array(O.OP_GEN_VERTEX_ARRAYS, session.vertexArrays.map((array) => array.name).filter(Boolean), w);
  for (const array of session.vertexArrays) {
    w.u(O.OP_BIND_VERTEX_ARRAY, array.name);
    w.u(O.OP_BIND_BUFFER, GL_ELEMENT_ARRAY_BUFFER, array.element ?? 0);
    for (const attribute of array.attributes) {
      w.u(O.OP_BIND_BUFFER, GL_ARRAY_BUFFER, attribute.buffer ?? 0);
      w.record(O.OP_VERTEX_ATTRIB_POINTER, [
        ["u", attribute.index], ["i", attribute.size], ["u", attribute.type],
        ["u", attribute.normalized ? 1 : 0], ["i", attribute.stride], ["i", attribute.offset],
      ]);
      w.u(attribute.enabled ? O.OP_ENABLE_VERTEX_ATTRIB_ARRAY : O.OP_DISABLE_VERTEX_ATTRIB_ARRAY, attribute.index);
    }
  }

  for (const framebuffer of session.framebuffers) {
    w.u(O.OP_BIND_FRAMEBUFFER, GL_FRAMEBUFFER, framebuffer.name);
    for (const attachment of framebuffer.attachments) {
      if (attachment.kind === "texture") {
        w.record(O.OP_FRAMEBUFFER_TEXTURE_2D, [
          ["u", GL_FRAMEBUFFER], ["u", attachment.attachment], ["u", attachment.target],
          ["u", attachment.name], ["i", attachment.level],
        ]);
      } else {
        w.u(O.OP_FRAMEBUFFER_RENDERBUFFER, GL_FRAMEBUFFER, attachment.attachment, GL_RENDERBUFFER, attachment.name);
      }
    }
  }

  if (session.state) stateCommands(session.state, w);
  return w.finish();
}

/** Records that delete the programs the guest deleted while still in use. */
export function glDeletionCommands(session: CheckpointGlSession): Uint8Array[] {
  const w = new CommandWriter();
  for (const program of session.programs) if (program.deletePending) w.u(O.OP_DELETE_PROGRAM, program.name);
  return w.finish();
}

function stateCommands(s: CheckpointGlState, w: CommandWriter): void {
  const f = (op: number, ...values: number[]) => w.record(op, values.map((value) => ["f", value] as const));
  w.record(O.OP_VIEWPORT, s.viewport.map((value) => ["i", value] as const));
  w.record(O.OP_SCISSOR, s.scissor.map((value) => ["i", value] as const));
  for (const { cap, enabled } of s.capabilities) w.u(enabled ? O.OP_ENABLE : O.OP_DISABLE, cap);
  f(O.OP_CLEAR_COLOR, ...s.clearColor);
  f(O.OP_CLEAR_DEPTHF, s.clearDepth);
  w.record(O.OP_CLEAR_STENCIL, [["i", s.clearStencil]]);
  w.u(O.OP_COLOR_MASK, ...s.colorMask.map(Number));
  w.u(O.OP_DEPTH_FUNC, s.depthFunc);
  w.u(O.OP_DEPTH_MASK, s.depthMask ? 1 : 0);
  f(O.OP_DEPTH_RANGEF, ...s.depthRange);
  for (const face of s.stencil) {
    w.record(O.OP_STENCIL_FUNC_SEPARATE, [["u", face.face], ["u", face.func], ["i", face.ref], ["u", face.valueMask]]);
    w.u(O.OP_STENCIL_MASK_SEPARATE, face.face, face.writeMask);
    w.u(O.OP_STENCIL_OP_SEPARATE, face.face, face.fail, face.zfail, face.zpass);
  }
  w.u(O.OP_BLEND_FUNC_SEPARATE, ...s.blendFunc);
  w.u(O.OP_BLEND_EQUATION_SEPARATE, ...s.blendEquation);
  f(O.OP_BLEND_COLOR, ...s.blendColor);
  w.u(O.OP_CULL_FACE, s.cullFace);
  w.u(O.OP_FRONT_FACE, s.frontFace);
  f(O.OP_LINE_WIDTH, s.lineWidth);
  f(O.OP_POLYGON_OFFSET, ...s.polygonOffset);
  w.record(O.OP_SAMPLE_COVERAGE, [["f", s.sampleCoverage[0]], ["u", s.sampleCoverage[1] ? 1 : 0]]);
  w.u(O.OP_PIXEL_STOREI, GL_UNPACK_ALIGNMENT, s.unpackAlignment);
  w.u(O.OP_PIXEL_STOREI, GL_PACK_ALIGNMENT, s.packAlignment);
  for (const { index, value } of s.vertexAttribValues) {
    w.record(O.OP_VERTEX_ATTRIB_4FV, [["u", index], ...value.map((element) => ["f", element] as const)]);
  }
  for (const { unit, name } of s.textureUnits) {
    w.u(O.OP_ACTIVE_TEXTURE, GL_TEXTURE0 + unit);
    w.u(O.OP_BIND_TEXTURE, GL_TEXTURE_2D, name);
  }
  w.u(O.OP_ACTIVE_TEXTURE, GL_TEXTURE0 + s.activeTexture);
  w.u(O.OP_USE_PROGRAM, s.program);
  w.u(O.OP_BIND_VERTEX_ARRAY, s.vertexArray);
  w.u(O.OP_BIND_FRAMEBUFFER, GL_FRAMEBUFFER, s.framebuffer);
  w.u(O.OP_BIND_RENDERBUFFER, GL_RENDERBUFFER, s.renderbuffer);
  w.u(O.OP_BIND_BUFFER, GL_ARRAY_BUFFER, s.arrayBuffer);
}
