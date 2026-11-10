import { detectPtrWidth, WASM_PAGE_SIZE } from "../constants";
import {
  CH_TOTAL_SIZE,
  POSIX_ARG_MAX_BYTES,
  PROCESS_METADATA_ENTRY_MAX_BYTES,
  PROCESS_STARTUP_MAX_ARGV_COUNT,
  PROCESS_STARTUP_MAX_ENVP_COUNT,
} from "../generated/abi";
import {
  FORK_CAP_ACTIVATION_STATE_SAFE,
  readForkInstrumentCapabilityClaim,
} from "../dylink";
import { readForkContinuationAnchor } from "../fork-continuation";
import { FORK_SAVE_BUFFER_SIZE } from "../process-memory";
import { drmFormatInfo } from "../webgl/drm-format-info";
import {
  MACHINE_CHECKPOINT_FORMAT,
  type CheckpointProcessBucket,
  type MachineCheckpoint,
} from "./checkpoint";
import { validatePersistentRoot } from "./persistent-root";
import {
  GL_ALPHA,
  GL_FLOAT,
  GL_HALF_FLOAT,
  GL_LUMINANCE,
  GL_LUMINANCE_ALPHA,
  GL_RGB,
  GL_RGBA,
  GL_UNSIGNED_BYTE,
  type CheckpointGlSession,
} from "../webgl/snapshot";
import { MAX_RECORD_PAYLOAD, uniformTypeCarried } from "../webgl/rebuild";
import { BUFFER_SNAPSHOT_CAPACITY, BUFFER_SNAPSHOT_MAX_BYTES } from "../webgl/buffer-snapshots";
import { FRAMEBUFFER_SNAPSHOT_CAPACITY } from "../webgl/framebuffer-snapshots";
import { validCurrentDrawable } from "../webgl/current";

/**
 * Refuse an untrusted checkpoint, on either host.
 *
 * A checkpoint arriving over a peer link carries kernel memory, process
 * memory, and program images, so it is the same input class as a boot
 * descriptor and a far more powerful one. A receiver validates everything it
 * can prove without instantiating any of it, and refuses with the exact
 * boundary that failed. The checks reuse the validators the local fork path
 * already trusts — `readForkContinuationAnchor` for the continuation root
 * geometry, `readForkInstrumentCapabilityClaim` for the activation-state
 * capability — rather than growing a second set that can drift.
 */
export class CheckpointRefusedError extends Error {}

/** Cap on a mount refusal's text, which a restore prints unaltered. */
const MAX_GAP_REASON_LENGTH = 200;

function refuse(reason: string): never {
  throw new CheckpointRefusedError(`checkpoint refused: ${reason}`);
}

/**
 * What a restore must say about the host mounts it did not get.
 *
 * A gap does not refuse the checkpoint: a machine short a host directory is
 * still worth moving. It does have to be said out loud, because a restore that
 * reports nothing presents the machine as whole. `null` means nothing is
 * missing.
 */
export function describeCheckpointMountGaps(
  checkpoint: MachineCheckpoint,
): string | null {
  const parts = checkpoint.unreadableFilesystems.map(
    (gap) => `${gap.mountPoint} (${gap.reason})`,
  );
  if (parts.length === 0) return null;
  return `this machine was restored without ${parts.join(", ")}`;
}

/**
 * Validate a checkpoint before any of it is instantiated.
 *
 * Compiling a bucket's program is validation, not instantiation: no import is
 * called and no memory is attached. The compiled modules are returned keyed
 * by pid so the boot path that accepts the checkpoint does not compile the
 * same bytes twice.
 */
export async function validateMachineCheckpoint(
  checkpoint: MachineCheckpoint,
  expected: {
    readonly kernelAbiVersion: number;
    readonly rootfsImageSha256: string | null;
  },
): Promise<ReadonlyMap<number, WebAssembly.Module>> {
  if (checkpoint.format !== MACHINE_CHECKPOINT_FORMAT) {
    refuse(
      `unknown checkpoint format ${String(checkpoint.format)}; `
      + `this host reads format ${MACHINE_CHECKPOINT_FORMAT}`,
    );
  }
  if (checkpoint.kernelAbiVersion !== expected.kernelAbiVersion) {
    refuse(
      `kernel ABI ${String(checkpoint.kernelAbiVersion)} does not match `
      + `this host's ABI ${expected.kernelAbiVersion}`,
    );
  }
  if (
    checkpoint.kernelMemory.byteLength === 0
    || checkpoint.kernelMemory.byteLength % WASM_PAGE_SIZE !== 0
  ) {
    refuse(
      `kernel memory is ${checkpoint.kernelMemory.byteLength} bytes, `
      + `not a whole number of pages`,
    );
  }
  // A persistent `/` brings its own base image, so the host boots none.
  if (checkpoint.persistentRoot !== null) {
    if (expected.rootfsImageSha256 !== null) {
      refuse(
        "the machine's / travels with its checkpoint, "
        + `and this host booted / image ${expected.rootfsImageSha256}`,
      );
    }
    const problem = validatePersistentRoot(checkpoint.persistentRoot);
    if (problem !== null) refuse(problem);
  }
  // The captured `/` reads every file the machine never modified out of its
  // boot image, by offset; over another image it would read the wrong bytes.
  // An image streamed from a file has no identity to compare, so a machine
  // booted from one cannot be restored, and the comparison below refuses a
  // host booted from one.
  if (checkpoint.persistentRoot === null && checkpoint.rootfsImageSha256 === null) {
    refuse("the machine booted / from an image with no identity, so no host can prove it boots the same one");
  }
  if (checkpoint.rootfsImageSha256 !== expected.rootfsImageSha256) {
    refuse(
      `the machine booted / image ${String(checkpoint.rootfsImageSha256)}, `
      + `and this host booted ${String(expected.rootfsImageSha256)}`,
    );
  }
  const seenMountPoints = new Set<string>();
  if (!Array.isArray(checkpoint.unreadableFilesystems)) {
    refuse("the checkpoint carries no unreadable-mount list");
  }
  for (const gap of checkpoint.unreadableFilesystems) {
    if (!gap.mountPoint.startsWith("/")) {
      refuse(
        `unreadable mount point ${JSON.stringify(gap.mountPoint)} `
        + "is not absolute",
      );
    }
    if (seenMountPoints.has(gap.mountPoint)) {
      refuse(`mount point ${JSON.stringify(gap.mountPoint)} appears twice`);
    }
    seenMountPoints.add(gap.mountPoint);
    // The reason is text a restore prints. A checkpoint arrives from a peer,
    // so cap it rather than relay an unbounded string into a diagnostic.
    if (gap.reason.length === 0 || gap.reason.length > MAX_GAP_REASON_LENGTH) {
      refuse(
        `the reason for unreadable mount ${JSON.stringify(gap.mountPoint)} `
        + `is ${gap.reason.length} characters`,
      );
    }
  }
  if (
    !Number.isSafeInteger(checkpoint.monotonicNs)
    || checkpoint.monotonicNs < 0
  ) {
    refuse(
      `the captured monotonic clock ${String(checkpoint.monotonicNs)} `
      + "is unusable",
    );
  }

  const modules = new Map<number, WebAssembly.Module>();
  for (const bucket of checkpoint.processes) {
    if (modules.has(bucket.pid)) {
      refuse(`pid ${bucket.pid} appears in more than one process bucket`);
    }
    modules.set(bucket.pid, await validateProcessBucket(bucket));
  }

  if (!Array.isArray(checkpoint.framebuffers)) {
    refuse("the checkpoint carries no framebuffer list");
  }
  const framebufferPids = new Set<number>();
  for (const framebuffer of checkpoint.framebuffers) {
    validateFramebuffer(
      framebuffer,
      checkpoint.processes.find((bucket) => bucket.pid === framebuffer.pid),
    );
    if (framebufferPids.has(framebuffer.pid)) {
      refuse(`pid ${framebuffer.pid} carries two framebuffer bindings`);
    }
    framebufferPids.add(framebuffer.pid);
  }
  validateKmsState(checkpoint.kms, checkpoint.processes, validateGl(checkpoint.gl, checkpoint.processes));
  return modules;
}

/** Caps on GL state a peer sent, far above anything a real guest makes. */
const MAX_GL_OBJECTS = 65_536;
const MAX_GL_TEXTURE_DIMENSION = 16_384;
const MAX_GL_BOUNDARY_LINES = 10_000;

const GL_CHANNELS = new Map([[GL_RGBA, 4], [GL_RGB, 3], [GL_LUMINANCE_ALPHA, 2], [GL_LUMINANCE, 1], [GL_ALPHA, 1]]);
const GL_TYPE_BYTES = new Map([[GL_UNSIGNED_BYTE, 1], [GL_HALF_FLOAT, 2], [GL_FLOAT, 4]]);

function isGlName(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 0xffff_ffff;
}

function isU32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function finiteNumbers(values: unknown, length: number): boolean {
  return Array.isArray(values) && values.length === length
    && values.every((value) => typeof value === "number" && Number.isFinite(value));
}

/** Refuse the GL device a checkpoint carries unless every session closes. */
function validateGl(
  gl: MachineCheckpoint["gl"],
  processes: readonly CheckpointProcessBucket[],
): Set<number> {
  if (gl === null || typeof gl !== "object" || !Array.isArray(gl.gpuBos) || !Array.isArray(gl.sessions)
      || gl.gpuBos.length > MAX_GL_OBJECTS || gl.sessions.length > MAX_GL_OBJECTS) {
    refuse("the checkpoint carries no GL device");
  }
  const gpuBoIds = new Set<number>();
  const gpuTexIds = new Set<number>();
  for (const bo of gl.gpuBos) {
    if (!isGlName(bo.boId) || gpuBoIds.has(bo.boId)) refuse(`GPU BO ${String(bo.boId)} appears twice`);
    gpuBoIds.add(bo.boId);
    if (!isGlName(bo.texId) || bo.texId > 0x7fff_ffff || gpuTexIds.has(bo.texId)) {
      refuse(`GPU BO ${bo.boId} carries an unusable texture id`);
    }
    gpuTexIds.add(bo.texId);
    const geometryUsable = [bo.width, bo.height].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_GL_TEXTURE_DIMENSION,
    );
    if (!geometryUsable || !isU32(bo.format)) refuse(`GPU BO ${bo.boId}'s geometry is unusable`);
    if (!(bo.pixels instanceof Uint8Array) || bo.pixels.byteLength !== bo.width * bo.height * 4) {
      refuse(`GPU BO ${bo.boId} carries ${String(bo.pixels?.byteLength)} pixel bytes`);
    }
  }
  const sessions = new Set<string>();
  for (const session of gl.sessions) {
    const key = `${String(session.pid)}:${String(session.sessionId)}`;
    if (sessions.has(key)) refuse(`GL session ${key} appears twice`);
    sessions.add(key);
    validateGlSession(session, processes.find((bucket) => bucket.pid === session.pid), gpuBoIds);
  }
  return gpuBoIds;
}

/**
 * Refuse a GL session the receiver cannot rebuild faithfully.
 *
 * A GL session arrives inside a checkpoint from a peer, so every count,
 * range, and cross-reference is checked before anything touches a real
 * WebGL2 context. References must close within the session: a framebuffer
 * naming a texture the checkpoint does not carry cannot be rebuilt, and
 * accepting it would restore a machine whose render targets are silently
 * gone.
 */
function validateGlSession(
  session: CheckpointGlSession,
  bucket: CheckpointProcessBucket | undefined,
  gpuBoIds: ReadonlySet<number>,
): void {
  const pid = session.pid;
  if (bucket === undefined) {
    refuse(`a GL session names pid ${String(pid)}, which has no process bucket`);
  }
  const where = `pid ${pid}'s GL session ${String(session.sessionId)}`;
  if (!isU32(session.sessionId) || (session.displayFileId !== null && !isKernelU64(session.displayFileId))) {
    refuse(`${where} has an unusable identity`);
  }
  const rangeUsable = [session.cmdbufAddr, session.cmdbufLen].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  if (!rangeUsable || session.cmdbufAddr + session.cmdbufLen > bucket.memory.byteLength) {
    refuse(`${where}'s cmdbuf does not fit inside its ${bucket.memory.byteLength}-byte memory`);
  }
  if (session.crtcId !== null && !isU32(session.crtcId)) refuse(`${where} names an unusable CRTC`);
  const surface = session.surface;
  if (surface !== null) {
    const usable = isGlName(surface.surfaceId) && (surface.kind === 1 || surface.kind === 2)
      && [surface.width, surface.height].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 0x7fff_ffff)
      && surface.samples === 0
      && [surface.targetBoId, surface.borrowedBoId].every((bo) => bo === 0 || gpuBoIds.has(bo));
    if (!usable) refuse(`${where}'s surface is unusable`);
  }
  if (session.context !== null && (!isU32(session.context.contextId) || typeof session.context.robustAccess !== "boolean")) {
    refuse(`${where}'s context is unusable`);
  }
  if (session.drawable !== null && !validCurrentDrawable(session.drawable)) {
    refuse(`${where}'s current drawable is unusable`);
  }
  for (const list of [session.buffers, session.textures, session.foreignTextures, session.renderbuffers,
    session.shaders, session.programs, session.vertexArrays, session.framebuffers]) {
    if (!Array.isArray(list) || list.length > MAX_GL_OBJECTS) refuse(`${where} carries an unusable object list`);
  }
  if (!Array.isArray(session.errors) || session.errors.length > 8
      || session.errors.some((error) => !Number.isInteger(error) || error < 0x500 || error > 0x507)) {
    refuse(`${where} carries an unusable error list`);
  }
  if (!Array.isArray(session.boundaries) || session.boundaries.length > MAX_GL_BOUNDARY_LINES
      || session.boundaries.some((line) => typeof line !== "string" || line.length > 500)) {
    refuse(`${where} carries an unusable boundary list`);
  }
  const names = (kind: string, list: readonly { name: number }[], zero = false): Set<number> => {
    const seen = new Set<number>();
    for (const object of list) {
      if (!(isGlName(object.name) || (zero && object.name === 0)) || seen.has(object.name)) {
        refuse(`${where} carries GL ${kind} ${String(object.name)} twice`);
      }
      seen.add(object.name);
    }
    return seen;
  };
  const closes = (kind: string, set: ReadonlySet<number>, name: number | null, by: string): void => {
    if (name !== null && name !== 0 && !set.has(name)) {
      refuse(`${where}'s ${by} names ${kind} ${String(name)}, which the checkpoint does not carry`);
    }
  };

  const buffers = names("buffer", session.buffers);
  for (const buffer of session.buffers) {
    if ((buffer.target !== 0x8892 && buffer.target !== 0x8893) || !isU32(buffer.usage)
        || !(buffer.bytes instanceof Uint8Array)) {
      refuse(`${where}'s GL buffer ${buffer.name} is unusable`);
    }
  }
  const textures = names("texture", session.textures);
  for (const texture of session.textures) {
    if (!Array.isArray(texture.levels) || texture.levels.length > 32
        || ![texture.minFilter, texture.magFilter, texture.wrapS, texture.wrapT].every(isU32)) {
      refuse(`${where}'s GL texture ${texture.name} is unusable`);
    }
    for (const level of texture.levels) {
      const geometryUsable = [level.level, level.width, level.height].every(
        (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_GL_TEXTURE_DIMENSION,
      ) && level.level < 32 && [level.internalFormat, level.format, level.type].every(isU32);
      if (!geometryUsable) refuse(`${where}'s GL texture ${texture.name} level ${String(level.level)} is unusable`);
      if (level.pixels === null) continue;
      const channels = GL_CHANNELS.get(level.format), bytes = GL_TYPE_BYTES.get(level.type);
      const expected = level.width * level.height * (channels ?? 0) * (bytes ?? 0);
      if (!channels || !bytes || !(level.pixels instanceof Uint8Array) || level.pixels.byteLength !== expected) {
        refuse(`${where}'s GL texture ${texture.name} level ${level.level} carries unusable texels`);
      }
    }
  }
  if (!isGlName(session.nextForeignTexId)) refuse(`${where} carries an unusable next foreign texture name`);
  for (const foreign of session.foreignTextures) {
    const by = `GL foreign texture ${String(foreign.name)}`;
    if (!isGlName(foreign.name) || textures.has(foreign.name)) refuse(`${where} carries GL texture ${String(foreign.name)} twice`);
    textures.add(foreign.name);
    const usable = [foreign.width, foreign.height].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_GL_TEXTURE_DIMENSION,
    ) && [foreign.minFilter, foreign.magFilter, foreign.wrapS, foreign.wrapT].every(isU32);
    if (!usable || !isGlName(foreign.boId)) refuse(`${where}'s ${by} is unusable`);
    const pixelsUsable = foreign.pixels === null
      ? gpuBoIds.has(foreign.boId)
      : foreign.pixels instanceof Uint8Array && foreign.pixels.byteLength === foreign.width * foreign.height * 4;
    if (!pixelsUsable) refuse(`${where}'s ${by} carries unusable texels`);
  }
  const renderbuffers = names("renderbuffer", session.renderbuffers);
  for (const renderbuffer of session.renderbuffers) {
    const usable = isU32(renderbuffer.internalFormat) && [renderbuffer.width, renderbuffer.height].every(
      (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_GL_TEXTURE_DIMENSION,
    );
    if (!usable) refuse(`${where}'s GL renderbuffer ${renderbuffer.name} is unusable`);
  }
  const shaders = names("shader", session.shaders);
  for (const shader of session.shaders) {
    if ((shader.type !== 0x8b30 && shader.type !== 0x8b31)
        || (shader.source !== null && (!(shader.source instanceof Uint8Array) || shader.source.byteLength > MAX_RECORD_PAYLOAD - 8))
        || typeof shader.compiled !== "boolean" || typeof shader.deletePending !== "boolean") {
      refuse(`${where}'s GL shader ${shader.name} is unusable`);
    }
  }
  const programs = names("program", session.programs);
  for (const program of session.programs) {
    const by = `GL program ${program.name}`;
    if (!Array.isArray(program.shaders) || program.shaders.length > 16
        || !Array.isArray(program.attribBindings) || program.attribBindings.length > 256
        || !Array.isArray(program.uniforms) || program.uniforms.length > MAX_GL_OBJECTS
        || !Array.isArray(program.values) || program.values.length > MAX_GL_OBJECTS
        || typeof program.linked !== "boolean" || typeof program.deletePending !== "boolean") {
      refuse(`${where}'s ${by} is unusable`);
    }
    for (const shader of program.shaders) closes("shader", shaders, shader, by);
    for (const binding of program.attribBindings) {
      if (typeof binding.name !== "string" || binding.name.length > 256 || !isU32(binding.index)) {
        refuse(`${where}'s ${by} binds an unusable attribute`);
      }
    }
    for (const entry of program.uniforms) {
      if (typeof entry.name !== "string" || entry.name.length > 1024 || !uniformTypeCarried(entry.type)
          || !isU32(entry.guestType) || !isU32(entry.location) || typeof entry.array !== "boolean"
          || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_GL_OBJECTS) {
        refuse(`${where}'s ${by} numbers an unusable uniform`);
      }
    }
    for (const value of program.values) {
      if (!isU32(value.location) || !uniformTypeCarried(value.type) || !Array.isArray(value.values)
          || value.values.length > 16 || !finiteNumbers(value.values, value.values.length)) {
        refuse(`${where}'s ${by} carries an unusable uniform value`);
      }
    }
  }
  const vertexArrays = names("vertex array", session.vertexArrays, true);
  for (const array of session.vertexArrays) {
    const by = `GL vertex array ${array.name}`;
    closes("buffer", buffers, array.element, by);
    if (!Array.isArray(array.attributes) || array.attributes.length > 256) refuse(`${where}'s ${by} is unusable`);
    for (const attribute of array.attributes) {
      closes("buffer", buffers, attribute.buffer, by);
      const usable = [attribute.index, attribute.type].every(isU32)
        && [attribute.size, attribute.stride, attribute.offset].every((value) => Number.isSafeInteger(value) && value >= 0)
        && typeof attribute.enabled === "boolean" && typeof attribute.normalized === "boolean";
      if (!usable) refuse(`${where}'s ${by} carries an unusable attribute`);
    }
  }
  const framebuffers = names("framebuffer", session.framebuffers);
  for (const framebuffer of session.framebuffers) {
    const by = `GL framebuffer ${framebuffer.name}`;
    if (!Array.isArray(framebuffer.attachments) || framebuffer.attachments.length > 8) {
      refuse(`${where}'s ${by} is unusable`);
    }
    for (const attachment of framebuffer.attachments) {
      if (attachment.kind !== "texture" && attachment.kind !== "renderbuffer") refuse(`${where}'s ${by} is unusable`);
      if (![attachment.attachment, attachment.target, attachment.level].every(isU32) || !isGlName(attachment.name)) {
        refuse(`${where}'s ${by} carries an unusable attachment`);
      }
      closes(attachment.kind, attachment.kind === "texture" ? textures : renderbuffers, attachment.name, by);
    }
  }
  validateGlProgramJournal(session, where, { programs, buffers, textures, framebuffers }, closes);
  const state = session.state;
  if (state === null) return;
  const shapeUsable = finiteNumbers(state.viewport, 4) && finiteNumbers(state.scissor, 4)
    && finiteNumbers(state.clearColor, 4) && finiteNumbers(state.blendColor, 4)
    && finiteNumbers(state.depthRange, 2) && finiteNumbers(state.polygonOffset, 2)
    && finiteNumbers(state.blendFunc, 4) && finiteNumbers(state.blendEquation, 2)
    && Array.isArray(state.colorMask) && state.colorMask.length === 4
    && Array.isArray(state.capabilities) && state.capabilities.length <= 16
    && Array.isArray(state.stencil) && state.stencil.length === 2
    && Array.isArray(state.vertexAttribValues) && state.vertexAttribValues.length <= 256
    && Array.isArray(state.textureUnits) && state.textureUnits.length <= 256
    && Array.isArray(state.sampleCoverage) && state.sampleCoverage.length === 2;
  if (!shapeUsable) refuse(`${where}'s GL context state is unusable`);
  closes("program", programs, state.program, "GL context state");
  closes("vertex array", vertexArrays, state.vertexArray, "GL context state");
  closes("framebuffer", framebuffers, state.framebuffer, "GL context state");
  closes("renderbuffer", renderbuffers, state.renderbuffer, "GL context state");
  closes("buffer", buffers, state.arrayBuffer, "GL context state");
  for (const unit of state.textureUnits) {
    if (!isU32(unit.unit) || unit.unit >= 256) refuse(`${where}'s GL context binds an unusable texture unit`);
    closes("texture", textures, unit.name, "GL context state");
  }
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Refuse program journal state the rebuild cannot hand back exactly: every
 * handle, token and cell must close over the objects the session carries. */
function validateGlProgramJournal(
  session: CheckpointGlSession,
  where: string,
  objects: Record<"programs" | "buffers" | "textures" | "framebuffers", ReadonlySet<number>>,
  closes: (kind: string, set: ReadonlySet<number>, name: number | null, by: string) => void,
): void {
  const receipt = session.programJournalReceipt;
  if (!Array.isArray(receipt) || receipt.length !== 12 || !receipt.every(isU32)) {
    refuse(`${where} carries an unusable program journal receipt`);
  }
  const captures = session.programCaptures;
  if (captures !== null) {
    const by = "program capture";
    const handles = new Set<number>();
    if (!isGlName(captures.next) || !Array.isArray(captures.handles) || captures.handles.length > MAX_GL_OBJECTS) {
      refuse(`${where}'s program captures are unusable`);
    }
    for (const { handle, name } of captures.handles) {
      if (!isGlName(handle) || handle >= captures.next || handles.has(handle) || !isGlName(name)) {
        refuse(`${where}'s program capture ${String(handle)} is unusable`);
      }
      handles.add(handle);
      closes("program", objects.programs, name, by);
    }
  }
  const order = session.programJournalOrder;
  if (order !== null && (!isCount(order.sequence) || !isGlName(order.nextJournal))) {
    refuse(`${where}'s program journal order is unusable`);
  }
  const journal = session.programJournal;
  if (journal === null) return;
  const by = "program journal";
  const shapeUsable = order !== null && isGlName(journal.id) && journal.id < order.nextJournal
    && Number.isInteger(journal.capacity) && journal.capacity >= 1 && journal.capacity <= 256
    && typeof journal.guestMetadata === "boolean" && isGlName(journal.nextGeneration)
    && isCount(journal.published) && journal.executed === journal.published
    && isU32(journal.logicalName) && typeof journal.uniformCpu === "boolean"
    && Array.isArray(journal.generations) && journal.generations.length <= MAX_GL_OBJECTS
    && Array.isArray(journal.slots) && journal.slots.length <= journal.capacity
    && Array.isArray(journal.ownedDraws) && journal.ownedDraws.length === 16;
  if (!shapeUsable) refuse(`${where}'s program journal is unusable`);
  closes("program", objects.programs, journal.logicalName, by);
  const tokens = new Set<number>();
  for (const { token, name, cache } of journal.generations) {
    if (!isU32(token) || token >= journal.nextGeneration || tokens.has(token) || typeof cache !== "boolean" || !isGlName(name)) {
      refuse(`${where}'s program journal generation ${String(token)} is unusable`);
    }
    tokens.add(token);
    closes("program", objects.programs, name, by);
  }
  if (journal.current !== null && !tokens.has(journal.current)) refuse(`${where}'s program journal selects no generation it carries`);
  const indexes = new Set<number>();
  for (const { index, ticket, sequence } of journal.slots) {
    if (!Number.isInteger(index) || index < 0 || index >= journal.capacity || indexes.has(index)
        || !isCount(ticket) || ticket > journal.published || !isCount(sequence)) {
      refuse(`${where}'s program journal cell ${String(index)} is unusable`);
    }
    indexes.add(index);
  }
  for (const draw of journal.ownedDraws) {
    if (![draw.token, draw.target, draw.targetToken].every(isU32) || (draw.family !== 0 && draw.family !== 1)
        || typeof draw.ready !== "boolean") {
      refuse(`${where}'s program journal carries an unusable owned draw`);
    }
  }
  const buffers = journal.buffers;
  if (buffers !== null) {
    if (!Number.isInteger(buffers.capacity) || buffers.capacity < 1 || buffers.capacity > BUFFER_SNAPSHOT_CAPACITY
        || !Array.isArray(buffers.cells) || buffers.cells.length !== buffers.capacity) {
      refuse(`${where}'s buffer snapshots are unusable`);
    }
    for (const cell of buffers.cells) {
      const bytesUsable = cell.bytes === null
        || (cell.bytes instanceof Uint8Array && cell.bytes.byteLength <= BUFFER_SNAPSHOT_MAX_BYTES);
      if (!isU32(cell.token) || !isU32(cell.buffer) || !bytesUsable) refuse(`${where}'s buffer snapshot ${String(cell.token)} is unusable`);
      closes("buffer", objects.buffers, cell.buffer, "buffer snapshot");
    }
  }
  const framebuffers = journal.framebuffers;
  if (framebuffers !== null) {
    if (!Array.isArray(framebuffers) || framebuffers.length !== FRAMEBUFFER_SNAPSHOT_CAPACITY) {
      refuse(`${where}'s framebuffer snapshots are unusable`);
    }
    for (const cell of framebuffers) {
      if (!isU32(cell.token) || !isU32(cell.framebuffer) || !Array.isArray(cell.inputs) || cell.inputs.length > 16
          || (cell.framebuffer !== 0 && cell.token === 0)) {
        refuse(`${where}'s framebuffer snapshot ${String(cell.token)} is unusable`);
      }
      closes("framebuffer", objects.framebuffers, cell.framebuffer, "framebuffer snapshot");
      for (const input of cell.inputs) {
        if (!Number.isInteger(input.unit) || input.unit < 0 || input.unit >= 16 || !isGlName(input.texture)) {
          refuse(`${where}'s framebuffer snapshot ${cell.token} samples an unusable input`);
        }
        closes("texture", objects.textures, input.texture, "framebuffer snapshot");
      }
    }
  }
}

/**
 * Refuse a modeset display the receiver cannot rebuild faithfully.
 *
 * A CRTC binding outlives `rmFb` on its framebuffer, so a CRTC naming an
 * absent `fb_id` is DRM-correct and accepted. Everything else must close: a
 * framebuffer names a buffer that travels, a buffer's pixels fill it, and a
 * mapped range fits the memory of a process the checkpoint carries.
 */
function validateKmsState(
  kms: MachineCheckpoint["kms"],
  processes: readonly CheckpointProcessBucket[],
  gpuBoIds: ReadonlySet<number>,
): void {
  if (kms === null || typeof kms !== "object") {
    refuse("the checkpoint carries no KMS state");
  }
  if (
    !Array.isArray(kms.fbs)
    || !Array.isArray(kms.crtcs)
    || !Array.isArray(kms.buffers)
  ) {
    refuse("the KMS state is not a framebuffer, CRTC, and buffer list");
  }

  const bufferIds = new Set<number>();
  for (const buffer of kms.buffers) {
    const geometryUsable = [buffer.bo_id, buffer.size, buffer.w, buffer.h, buffer.stride]
      .every((value) => Number.isSafeInteger(value) && value >= 0);
    if (!geometryUsable || buffer.w === 0 || buffer.h === 0 || buffer.stride < buffer.w) {
      refuse(`buffer object ${String(buffer.bo_id)}'s geometry is unusable`);
    }
    if (bufferIds.has(buffer.bo_id)) {
      refuse(`buffer object ${buffer.bo_id} appears twice`);
    }
    bufferIds.add(buffer.bo_id);
    if (buffer.size < buffer.h * buffer.stride) {
      refuse(
        `buffer object ${buffer.bo_id} is ${buffer.size} bytes, `
        + `too small for a ${buffer.h}-row ${buffer.stride}-byte stride`,
      );
    }
    if (buffer.pixels.byteLength !== buffer.size) {
      refuse(
        `buffer object ${buffer.bo_id} carries ${buffer.pixels.byteLength} `
        + `pixel bytes for a ${buffer.size}-byte buffer`,
      );
    }
    if (buffer.pids.length === 0) {
      refuse(`buffer object ${buffer.bo_id} is held by no process`);
    }
    for (const pid of buffer.pids) {
      if (!processes.some((bucket) => bucket.pid === pid)) {
        refuse(
          `buffer object ${buffer.bo_id} is held by pid ${String(pid)}, `
          + "which has no process bucket",
        );
      }
    }
    for (const binding of buffer.bindings) {
      const bucket = processes.find((candidate) => candidate.pid === binding.pid);
      if (bucket === undefined) {
        refuse(
          `buffer object ${buffer.bo_id} is mapped by pid ${String(binding.pid)}, `
          + "which has no process bucket",
        );
      }
      const rangeUsable = [binding.addr, binding.len, binding.boOffset ?? 0].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) && (binding.boOffset ?? 0) <= buffer.size;
      if (!rangeUsable || binding.len === 0 || binding.addr + binding.len > bucket.memory.byteLength) {
        refuse(
          `buffer object ${buffer.bo_id}'s mapping in pid ${binding.pid} does `
          + `not fit inside its ${bucket.memory.byteLength}-byte memory`,
        );
      }
    }
  }

  const fbIds = new Set<number>();
  for (const fb of kms.fbs) {
    const geometryUsable = [fb.fb_id, fb.bo_id, fb.width, fb.height, fb.pitch, fb.offset ?? 0]
      .every((value) => Number.isSafeInteger(value) && value >= 0);
    const bytesPerPixel = drmFormatInfo(fb.pixel_format)?.cpp[0];
    if (
      !geometryUsable || bytesPerPixel === undefined || fb.width === 0 || fb.height === 0
      || fb.pitch < fb.width * bytesPerPixel
    ) {
      refuse(`framebuffer ${String(fb.fb_id)}'s geometry is unusable`);
    }
    if (fbIds.has(fb.fb_id)) refuse(`framebuffer ${fb.fb_id} appears twice`);
    fbIds.add(fb.fb_id);
    if (!bufferIds.has(fb.bo_id) && !gpuBoIds.has(fb.bo_id)) {
      refuse(
        `framebuffer ${fb.fb_id} scans out buffer object ${fb.bo_id}, `
        + "which the checkpoint does not carry",
      );
    }
  }

  const crtcIds = new Set<number>();
  for (const crtc of kms.crtcs) {
    if (!Number.isSafeInteger(crtc.crtc_id) || !Number.isSafeInteger(crtc.fb_id)) {
      refuse(`a CRTC binding names ${String(crtc.crtc_id)} and ${String(crtc.fb_id)}`);
    }
    if (crtcIds.has(crtc.crtc_id)) {
      refuse(`CRTC ${crtc.crtc_id} is bound twice`);
    }
    crtcIds.add(crtc.crtc_id);
    if (crtc.viewport === undefined) continue;
    const { x, y, width, height } = crtc.viewport;
    const viewportUsable = [x, y, width, height]
      .every((value) => Number.isSafeInteger(value) && value >= 0);
    if (!viewportUsable || width === 0 || height === 0) {
      refuse(`CRTC ${crtc.crtc_id}'s viewport is unusable`);
    }
  }

  if (!isKernelU64(kms.lastMasterLeaseId)) {
    refuse(`the newest DRM master lease ${String(kms.lastMasterLeaseId)} is not a u64`);
  }
  if (kms.master !== null) {
    const fileId = kms.master?.fileId, leaseId = kms.master?.leaseId;
    if (!isKernelU64(fileId) || !isKernelU64(leaseId) || BigInt(fileId) === 0n || BigInt(leaseId) === 0n) {
      refuse(`the DRM master grant names file ${String(fileId)} and lease ${String(leaseId)}`);
    }
    if (BigInt(leaseId) > BigInt(kms.lastMasterLeaseId)) {
      refuse(`DRM master lease ${leaseId} is newer than the newest lease ${kms.lastMasterLeaseId}`);
    }
  }

  if (!Array.isArray(kms.gammas)) refuse("the KMS state carries no gamma list");
  const gammaCrtcs = new Set<number>();
  for (const gamma of kms.gammas) {
    if (!Number.isSafeInteger(gamma.crtc_id) || gammaCrtcs.has(gamma.crtc_id)) {
      refuse(`a gamma table names CRTC ${String(gamma.crtc_id)} again or unusably`);
    }
    gammaCrtcs.add(gamma.crtc_id);
    if (!(gamma.table instanceof Uint8Array) || gamma.table.byteLength !== 768) {
      refuse(`CRTC ${gamma.crtc_id}'s gamma table is not 768 bytes`);
    }
  }

  const cursor = kms.cursor;
  if (cursor === null || typeof cursor !== "object") refuse("the KMS state carries no cursor plane");
  const { bo, fbId, x, y, hotX, hotY, width, height } = cursor;
  const cursorUsable = [bo, fbId, width, height].every((value) => Number.isSafeInteger(value) && value >= 0)
    && [x, y, hotX, hotY].every((value) => Number.isSafeInteger(value))
    && width <= 64 && height <= 64
    && (bo === 0) === (fbId === 0)
    && (bo === 0 ? width === 0 && height === 0 : width > 0 && height > 0);
  if (!cursorUsable) refuse("the cursor plane's image or geometry is unusable");
  if (bo !== 0 && !bufferIds.has(bo)) {
    refuse(`the cursor plane shows buffer object ${bo}, which the checkpoint does not carry`);
  }

  if (kms.masterPid === null) return;
  if (!processes.some((bucket) => bucket.pid === kms.masterPid)) {
    refuse(
      `DRM master is pid ${String(kms.masterPid)}, which has no process bucket`,
    );
  }
}

/** Whether `value` is a kernel u64 identity written in decimal. */
function isKernelU64(value: unknown): value is string {
  return typeof value === "string"
    && /^(0|[1-9][0-9]{0,19})$/.test(value)
    && BigInt(value) <= 0xffff_ffff_ffff_ffffn;
}

/**
 * Refuse a framebuffer record the receiver cannot rebind faithfully.
 *
 * A write-based binding (the `addr === 0 && len === 0` sentinel) must carry
 * exactly one frame of pixels; an mmap-based binding must name a range inside
 * its process's memory and carries no host pixels — they ride in the memory
 * copy.
 */
function validateFramebuffer(
  framebuffer: MachineCheckpoint["framebuffers"][number],
  bucket: CheckpointProcessBucket | undefined,
): void {
  const { pid, addr, len, w, h, stride, hostBuffer } = framebuffer;
  if (bucket === undefined) {
    refuse(`a framebuffer names pid ${pid}, which has no process bucket`);
  }
  const dimensionsUsable = [addr, len, w, h, stride].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  if (!dimensionsUsable || w === 0 || h === 0 || stride < w * 4) {
    refuse(`pid ${pid}'s framebuffer geometry is unusable`);
  }
  const writeBased = addr === 0 && len === 0;
  if (writeBased) {
    if (hostBuffer === null || hostBuffer.byteLength !== h * stride) {
      refuse(
        `pid ${pid}'s write-based framebuffer carries `
        + `${hostBuffer?.byteLength ?? 0} pixel bytes for a `
        + `${h * stride}-byte frame`,
      );
    }
    return;
  }
  if (hostBuffer !== null) {
    refuse(
      `pid ${pid}'s mmap-based framebuffer carries host pixels; `
      + "its frame rides in the process memory copy",
    );
  }
  if (len === 0 || addr + len > bucket.memory.byteLength) {
    refuse(
      `pid ${pid}'s framebuffer range does not fit inside its `
      + `${bucket.memory.byteLength}-byte memory`,
    );
  }
}

/**
 * Refuse startup metadata a restored worker cannot serve faithfully.
 *
 * A restored guest parked inside `_start` re-reads these entries through its
 * worker's startup imports, under the same generated caps the CRT enforces.
 * A checkpoint that exceeds them could never have been captured from a real
 * launch.
 */
function validateStartupEntries(
  pid: number,
  what: "argv" | "environment",
  entries: readonly string[],
  maxCount: number,
): void {
  if (!Array.isArray(entries) || entries.length > maxCount) {
    refuse(`pid ${pid}'s ${what} list is unusable`);
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (typeof entry !== "string") {
      refuse(`pid ${pid}'s ${what} carries a non-string entry`);
    }
    const byteLength = new TextEncoder().encode(entry).byteLength;
    if (byteLength > PROCESS_METADATA_ENTRY_MAX_BYTES) {
      refuse(`pid ${pid}'s ${what} carries a ${byteLength}-byte entry`);
    }
    totalBytes += byteLength + 1;
  }
  if (totalBytes > POSIX_ARG_MAX_BYTES) {
    refuse(`pid ${pid}'s ${what} exceeds ARG_MAX`);
  }
}

async function validateProcessBucket(
  bucket: CheckpointProcessBucket,
): Promise<WebAssembly.Module> {
  const pid = bucket.pid;
  if (bucket.ptrWidth !== 4 && bucket.ptrWidth !== 8) {
    refuse(`pid ${pid} claims pointer width ${String(bucket.ptrWidth)}`);
  }
  validateStartupEntries(pid, "argv", bucket.argv, PROCESS_STARTUP_MAX_ARGV_COUNT);
  validateStartupEntries(pid, "environment", bucket.env, PROCESS_STARTUP_MAX_ENVP_COUNT);
  const memory = bucket.memory;
  if (
    memory.byteOffset !== 0
    || memory.byteLength !== memory.buffer.byteLength
  ) {
    refuse(`pid ${pid}'s memory view does not cover its whole buffer`);
  }
  if (
    memory.byteLength === 0
    || memory.byteLength % WASM_PAGE_SIZE !== 0
  ) {
    refuse(
      `pid ${pid}'s memory is ${memory.byteLength} bytes, `
      + `not a whole number of pages`,
    );
  }
  if (
    !Number.isSafeInteger(bucket.channelOffset)
    || bucket.channelOffset <= FORK_SAVE_BUFFER_SIZE
    || bucket.channelOffset + CH_TOTAL_SIZE > memory.byteLength
  ) {
    refuse(
      `pid ${pid}'s syscall channel at ${String(bucket.channelOffset)} `
      + `does not fit inside its ${memory.byteLength}-byte memory`,
    );
  }

  const module = await WebAssembly.compile(bucket.programBytes).catch(
    (error: unknown) => refuse(
      `pid ${pid}'s program is not a WebAssembly module: `
      + (error instanceof Error ? error.message : String(error)),
    ),
  );
  const claim = (() => {
    try {
      return readForkInstrumentCapabilityClaim(module);
    } catch (error) {
      refuse(
        `pid ${pid}'s program carries a malformed capability claim: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  })();
  if (!claim.present || (claim.flags & FORK_CAP_ACTIVATION_STATE_SAFE) === 0) {
    refuse(
      `pid ${pid}'s program does not claim activation-state-safe replay, `
      + `so a fresh instance cannot resume it`,
    );
  }
  if (detectPtrWidth(bucket.programBytes) !== bucket.ptrWidth) {
    refuse(
      `pid ${pid} claims pointer width ${bucket.ptrWidth} but its program `
      + `declares ${detectPtrWidth(bucket.programBytes)}`,
    );
  }

  try {
    readForkContinuationAnchor(
      { buffer: memory.buffer },
      bucket.channelOffset - FORK_SAVE_BUFFER_SIZE,
      bucket.ptrWidth,
    );
  } catch (error) {
    refuse(
      `pid ${pid}'s continuation root is unusable: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }

  if (!Array.isArray(bucket.threads)) {
    refuse(`pid ${pid}'s bucket carries no thread list`);
  }
  if (bucket.threads.length !== bucket.threadAllocator.activeCount) {
    refuse(
      `pid ${pid} carries ${bucket.threads.length} thread record(s) but its `
      + `allocator holds ${bucket.threadAllocator.activeCount} live slot(s)`,
    );
  }
  const tids = new Set<number>();
  for (const thread of bucket.threads) {
    if (
      !Number.isSafeInteger(thread.tid)
      || thread.tid <= 0
      || thread.tid === pid
    ) {
      refuse(
        `pid ${pid} carries a thread with kernel TID ${String(thread.tid)}`,
      );
    }
    if (tids.has(thread.tid)) {
      refuse(`pid ${pid} carries kernel TID ${thread.tid} twice`);
    }
    tids.add(thread.tid);
    if (
      !Number.isSafeInteger(thread.channelOffset)
      || thread.channelOffset <= FORK_SAVE_BUFFER_SIZE
      || thread.channelOffset + CH_TOTAL_SIZE > memory.byteLength
      || thread.channelOffset === bucket.channelOffset
    ) {
      refuse(
        `pid ${pid} tid ${thread.tid}'s syscall channel at `
        + `${String(thread.channelOffset)} does not fit inside its `
        + `${memory.byteLength}-byte memory`,
      );
    }
    try {
      readForkContinuationAnchor(
        { buffer: memory.buffer },
        thread.channelOffset - FORK_SAVE_BUFFER_SIZE,
        bucket.ptrWidth,
      );
    } catch (error) {
      refuse(
        `pid ${pid} tid ${thread.tid}'s continuation root is unusable: `
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return module;
}
