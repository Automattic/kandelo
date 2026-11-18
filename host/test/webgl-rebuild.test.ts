import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeAndDispatch, validateCommandBuffer } from "../src/webgl/bridge.js";
import { GlContextRegistry, type GlBinding } from "../src/webgl/registry.js";
import * as O from "../src/webgl/ops.js";
import { glDeletionCommands, glObjectCommands, glStateCommands, MAX_RECORD_PAYLOAD } from "../src/webgl/rebuild.js";
import { seedUniformTemplate } from "../src/webgl/uniform-layout.js";
import { captureGlSession, type CheckpointGl, type CheckpointGlSession } from "../src/webgl/snapshot.js";
import {
  ABI_SYSCALLS,
  CHANNEL_STATUS_PENDING,
  CH_STATUS,
  CH_SYSCALL,
} from "../src/generated/abi";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { installKernelWorkerTestScratch } from "./kernel-worker-test-scratch";
import { loggingGraphicsGl } from "./support/logging-graphics-gl";

const VERTEX_SOURCE = new TextEncoder().encode("attribute vec2 aPosition; void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }");
const FRAGMENT_SOURCE = new TextEncoder().encode("void main() { gl_FragColor = vec4(1.0); }");

/** Every record of a frame, as (op, payload). */
function records(frame: Uint8Array): [number, DataView][] {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const out: [number, DataView][] = [];
  for (let at = 0; at < frame.byteLength;) {
    const op = view.getUint16(at, true), length = view.getUint16(at + 2, true);
    out.push([op, new DataView(frame.buffer, frame.byteOffset + at + 4, length)]);
    at += 4 + length;
  }
  return out;
}

/** A session as the capture of a fresh machine reads it: zero bytes and
 * texels, because the double renderer holds none. */
function session(overrides: Partial<CheckpointGlSession> = {}): CheckpointGlSession {
  return {
    pid: 1,
    sessionId: 0,
    displayFileId: null,
    cmdbufAddr: 0,
    cmdbufLen: 4096,
    crtcId: null,
    surface: null,
    context: null,
    drawable: null,
    buffers: [
      { name: 1, target: 0x8892, usage: 0x88e4, bytes: new Uint8Array(32) },
      { name: 2, target: 0x8893, usage: 0x88e4, bytes: new Uint8Array(12) },
    ],
    textures: [{
      name: 3,
      levels: [{
        level: 0, internalFormat: 0x1908, width: 4, height: 2, format: 0x1908, type: 0x1401,
        pixels: new Uint8Array(32),
      }],
      minFilter: 0x2601, magFilter: 0x2600, wrapS: 0x812f, wrapT: 0x2901,
    }],
    foreignTextures: [],
    nextForeignTexId: 0x4000_0000,
    renderbuffers: [{ name: 4, internalFormat: 0x81a5, width: 4, height: 2 }],
    shaders: [
      { name: 5, type: 0x8b31, source: VERTEX_SOURCE, compiled: true, deletePending: false },
      { name: 6, type: 0x8b30, source: FRAGMENT_SOURCE, compiled: true, deletePending: true },
    ],
    programs: [{
      name: 7, shaders: [5, 6], attribBindings: [{ name: "aPosition", index: 0 }],
      linked: true, deletePending: false, uniforms: [], values: [],
    }],
    vertexArrays: [
      {
        name: 0,
        element: 2,
        attributes: [{ index: 0, buffer: 1, enabled: true, size: 2, type: 0x1406, normalized: false, stride: 8, offset: 0 }],
      },
      { name: 8, element: null, attributes: [] },
    ],
    framebuffers: [{
      name: 9,
      attachments: [
        { attachment: 0x8ce0, kind: "texture", target: 0x0de1, name: 3, level: 0 },
        { attachment: 0x8d00, kind: "renderbuffer", target: 0x8d41, name: 4, level: 0 },
      ],
    }],
    state: {
      viewport: [0, 0, 4, 2],
      scissor: [1, 1, 2, 1],
      capabilities: [
        { cap: 0x0c11, enabled: true },
        { cap: 0x0b71, enabled: false },
        { cap: 0x0b90, enabled: false },
        { cap: 0x0be2, enabled: true },
        { cap: 0x0b44, enabled: false },
        { cap: 0x8037, enabled: false },
        { cap: 0x0bd0, enabled: true },
        { cap: 0x80a0, enabled: false },
        { cap: 0x809e, enabled: false },
      ],
      clearColor: [0.25, 0.5, 0.75, 1],
      clearDepth: 1,
      clearStencil: 0,
      colorMask: [true, true, true, true],
      depthFunc: 0x0201,
      depthMask: true,
      depthRange: [0, 1],
      stencil: [
        { face: 0x0404, func: 0x0207, ref: 0, valueMask: 0xffffffff, writeMask: 0xffffffff, fail: 0x1e00, zfail: 0x1e00, zpass: 0x1e00 },
        { face: 0x0405, func: 0x0207, ref: 0, valueMask: 0xffffffff, writeMask: 0xffffffff, fail: 0x1e00, zfail: 0x1e00, zpass: 0x1e00 },
      ],
      blendFunc: [0x0302, 0x0303, 1, 0x0303],
      blendEquation: [0x8006, 0x8006],
      blendColor: [0, 0, 0, 0],
      cullFace: 0x0405,
      frontFace: 0x0901,
      lineWidth: 1,
      polygonOffset: [0, 0],
      sampleCoverage: [1, false],
      unpackAlignment: 4,
      packAlignment: 4,
      vertexAttribValues: [],
      activeTexture: 1,
      textureUnits: [{ unit: 1, name: 3 }],
      program: 7,
      vertexArray: 0,
      framebuffer: 9,
      renderbuffer: 4,
      arrayBuffer: 1,
    },
    errors: [],
    boundaries: [],
    programCaptures: null,
    programJournalOrder: null,
    programJournal: null,
    programJournalReceipt: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x47514c33],
    ...overrides,
  };
}

/** The ownership double, with the vertex-attribute and texture-unit limits
 * a session that uses unit 1 and attribute 0 needs. */
function renderer(uniforms: { name: string; size: number; type: number }[] = []): WebGL2RenderingContext {
  const gl = loggingGraphicsGl(uniforms).gl as unknown as WebGL2RenderingContext;
  return new Proxy(gl, {
    get(target, key) {
      if (key !== "getParameter") return Reflect.get(target, key);
      return (pname: number) => pname === 0x8869 || pname === 0x8b4d ? 16 : target.getParameter(pname);
    },
  });
}

function replay(b: GlBinding, frames: readonly Uint8Array[]): void {
  for (const frame of frames) {
    expect(validateCommandBuffer(frame, 0, frame.byteLength)).toBe(0);
    b.cmdbufView = frame;
    expect(decodeAndDispatch(b, 0, frame.byteLength)).toBe(0);
  }
}

describe("glObjectCommands / glStateCommands", () => {
  it("writes frames the bridge accepts", () => {
    for (const frame of [...glObjectCommands(session()), ...glStateCommands(session())]) {
      expect(validateCommandBuffer(frame, 0, frame.byteLength)).toBe(0);
    }
  });

  it("splits texels into sub-images that cover the level exactly", () => {
    const width = 300, height = 70;
    const pixels = new Uint8Array(width * height * 4).map((_, index) => index & 0xff);
    const frames = glObjectCommands(session({
      buffers: [], renderbuffers: [], shaders: [], programs: [],
      textures: [{
        name: 3,
        levels: [{ level: 0, internalFormat: 0x1908, width, height, format: 0x1908, type: 0x1401, pixels }],
        minFilter: 0x2601, magFilter: 0x2601, wrapS: 0x812f, wrapT: 0x812f,
      }],
    }));
    const rebuilt = new Uint8Array(pixels.byteLength);
    let uploads = 0;
    for (const [op, payload] of frames.flatMap(records)) {
      if (op !== O.OP_TEX_SUB_IMAGE_2D) continue;
      uploads++;
      expect(payload.byteLength).toBeLessThanOrEqual(MAX_RECORD_PAYLOAD);
      const x = payload.getInt32(8, true), y = payload.getInt32(12, true);
      const w = payload.getInt32(16, true), h = payload.getInt32(20, true);
      const data = new Uint8Array(payload.buffer, payload.byteOffset + 36, payload.getUint32(32, true));
      for (let row = 0; row < h; row++) {
        rebuilt.set(data.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * width + x) * 4);
      }
    }
    expect(uploads).toBeGreaterThan(1);
    expect(rebuilt).toEqual(pixels);
  });

  it("splits a row wider than one record into spans", () => {
    const width = 5000, pixels = new Uint8Array(width * 4 * 4).fill(7);
    const frames = glObjectCommands(session({
      buffers: [], renderbuffers: [], shaders: [], programs: [],
      textures: [{
        name: 3,
        levels: [{ level: 0, internalFormat: 0x1908, width, height: 1, format: 0x1908, type: 0x1406, pixels }],
        minFilter: 0x2601, magFilter: 0x2601, wrapS: 0x812f, wrapT: 0x812f,
      }],
    }));
    const spans = frames.flatMap(records).filter(([op]) => op === O.OP_TEX_SUB_IMAGE_2D);
    expect(spans.reduce((total, [, payload]) => total + payload.getInt32(16, true), 0)).toBe(width);
    for (const [, payload] of spans) expect(payload.getInt32(20, true)).toBe(1);
  });

  it("sets each uniform location with the setter of its type", () => {
    const frames = glStateCommands(session({
      programs: [{
        name: 7, shaders: [], attribBindings: [], linked: true, deletePending: false,
        uniforms: [],
        values: [
          { location: 0, type: 0x8b50, values: [0.5, 0.25] },
          { location: 1, type: 0x8b5e, values: [3] },
          { location: 2, type: 0x8b5c, values: Array.from({ length: 16 }, (_, index) => index) },
        ],
      }],
    }));
    const uniforms = frames.flatMap(records).filter(([op]) => op >= O.OP_UNIFORM1I && op <= O.OP_UNIFORM_MATRIX3FV);
    expect(uniforms.map(([op]) => op)).toEqual([O.OP_UNIFORM2FV, O.OP_UNIFORM1IV, O.OP_UNIFORM_MATRIX4FV]);
    const [vector, sampler, matrix] = uniforms.map(([, payload]) => payload);
    expect([vector!.getInt32(0, true), vector!.getUint32(4, true), vector!.getFloat32(12, true)]).toEqual([0, 1, 0.25]);
    expect([sampler!.getInt32(0, true), sampler!.getInt32(8, true)]).toEqual([1, 3]);
    expect([matrix!.getUint32(8, true), matrix!.getFloat32(12 + 15 * 4, true)]).toEqual([0, 15]);
  });

  it("sets a foreign texture's sampler parameters on its guest name", () => {
    const frames = glStateCommands(session({
      foreignTextures: [{
        name: 0x4000_0000, boId: 5, width: 1, height: 1, pixels: new Uint8Array(4),
        minFilter: 0x2600, magFilter: 0x2600, wrapS: 0x2901, wrapT: 0x2901,
      }],
    }));
    const texturing = frames.flatMap(records)
      .filter(([op]) => op === O.OP_BIND_TEXTURE || op === O.OP_TEX_PARAMETERI)
      .slice(0, 6)
      .map(([op, payload]) => [op, ...new Uint32Array(payload.buffer.slice(payload.byteOffset + 4, payload.byteOffset + payload.byteLength))]);
    expect(texturing).toEqual([
      [O.OP_BIND_TEXTURE, 0x4000_0000],
      [O.OP_TEX_PARAMETERI, 0x2801, 0x2600],
      [O.OP_TEX_PARAMETERI, 0x2800, 0x2600],
      [O.OP_TEX_PARAMETERI, 0x2802, 0x2901],
      [O.OP_TEX_PARAMETERI, 0x2803, 0x2901],
      [O.OP_BIND_TEXTURE, 0],
    ]);
  });

  it("links before it sets uniforms, and deletes pending names last", () => {
    const ops = glStateCommands(session()).flatMap(records).map(([op]) => op);
    expect(ops.indexOf(O.OP_LINK_PROGRAM)).toBeLessThan(ops.indexOf(O.OP_DELETE_SHADER));
    expect(glObjectCommands(session()).flatMap(records).map(([op]) => op)).not.toContain(O.OP_LINK_PROGRAM);
  });

  it("deletes a delete-pending program only after the state, where a journal may pin it", () => {
    const pending = session({ programs: session().programs.map((program) => ({ ...program, deletePending: true })) });
    expect(glStateCommands(pending).flatMap(records).map(([op]) => op)).not.toContain(O.OP_DELETE_PROGRAM);
    expect(glDeletionCommands(pending).flatMap(records).map(([op, payload]) => [op, payload.getUint32(0, true)]))
      .toEqual([[O.OP_DELETE_PROGRAM, 7]]);
  });

  it("writes a half-float level with the GLES 2 token the wire accepts", () => {
    const half = session({
      textures: [{
        name: 3,
        levels: [{ level: 0, internalFormat: 0x1908, width: 1, height: 1, format: 0x1908, type: 0x140b, pixels: new Uint8Array(8) }],
        minFilter: 0x2601, magFilter: 0x2600, wrapS: 0x812f, wrapT: 0x2901,
      }],
    });
    const types = glObjectCommands(half).flatMap(records)
      .filter(([op]) => op === O.OP_TEX_IMAGE_2D || op === O.OP_TEX_SUB_IMAGE_2D)
      .map(([, payload]) => payload.getUint32(28, true));
    expect(types).toEqual([0x8d61, 0x8d61]);
  });
});

describe("rebuilding through the bridge", () => {
  function binding(uniforms: { name: string; size: number; type: number }[] = []): GlBinding {
    const registry = new GlContextRegistry();
    registry.bind({ pid: 1, cmdbufAddr: 0, cmdbufLen: 4096 });
    const b = registry.get(1)!;
    b.gl = renderer(uniforms);
    b.contextId = 1;
    return b;
  }

  it("builds the bridge's own records, which a capture reads back unchanged", () => {
    const b = binding();
    const original = session();
    replay(b, glObjectCommands(original));
    replay(b, glStateCommands(original));

    expect(b.errors).toEqual([]);
    expect(captureGlSession(b, null, 0)).toEqual({
      ...original,
      context: { contextId: 1, robustAccess: false },
      boundaries: ["renderbuffer contents cannot be read out of WebGL2; restored uninitialized"],
    });
  });

  it("refuses a linked program whose shaders were detached after its link", () => {
    const b = binding();
    const original = session();
    replay(b, glObjectCommands(original));
    replay(b, glStateCommands(original));
    const [program] = original.programs;
    const detach = new Uint8Array(12);
    const view = new DataView(detach.buffer);
    view.setUint16(0, O.OP_DETACH_SHADER, true);
    view.setUint16(2, 8, true);
    view.setUint32(4, program!.name, true);
    view.setUint32(8, program!.shaders[0]!, true);
    replay(b, [detach]);

    expect(() => captureGlSession(b, null, 0)).toThrow(/after its link, which the rebuild cannot link again/);
  });

  it("numbers a relinked program's uniforms as the checkpoint did", () => {
    // The captured renderer reflected `a` first; this one reflects `b` first.
    const b = binding([{ name: "b", size: 1, type: 0x1406 }, { name: "a", size: 1, type: 0x8b50 }]);
    const captured = session({
      programs: [{
        name: 7, shaders: [5, 6], attribBindings: [], linked: true, deletePending: false,
        uniforms: [
          { name: "a", type: 0x8b50, guestType: 0x8b50, size: 1, array: false, location: 0 },
          { name: "b", type: 0x1406, guestType: 0x1406, size: 1, array: false, location: 1 },
        ],
        values: [],
      }],
      state: null,
      shaders: session().shaders.map((shader) => ({ ...shader, deletePending: false })),
    });
    replay(b, glObjectCommands(captured));
    seedUniformTemplate(b.programs.get(7)!, captured.programs[0]!.uniforms);
    replay(b, glStateCommands(captured));

    const layout = captureGlSession(b, null, 0).programs[0]!.uniforms;
    expect(layout.map((entry) => [entry.name, entry.location])).toEqual([["a", 0], ["b", 1]]);
  });
});

describe("CentralizedKernelWorker GL restore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function makeWorker(kernelExports: Readonly<Record<string, unknown>> = {}) {
    const worker = createCentralizedKernelWorkerTestDouble({
      config: { maxWorkers: 1, dataBufferSize: 65_536, useSharedMemory: true },
      io: new NodePlatformIO(),
    });
    const kernelMemory = new WebAssembly.Memory({ initial: 2 });
    const implementations = {
      kernel_vblank: () => 0,
      kernel_get_process_exec_generation: (_pid: number, pointer: number | bigint) => {
        new DataView(kernelMemory.buffer).setBigUint64(Number(pointer), 1n, true);
        return 8;
      },
      ...kernelExports,
    };
    installKernelWorkerTestScratch(
      worker,
      kernelMemory,
      128,
      4,
      {
        kernelExports: implementations,
        kernelExportNames: Object.keys(implementations),
      },
    );
    return worker;
  }

  /** A device whose one session painted CRTC 1 with a live context. */
  function device(): CheckpointGl {
    return {
      gpuBos: [],
      sessions: [session({
        pid: 7,
        sessionId: 2,
        crtcId: 1,
        context: { contextId: 1, robustAccess: false },
        boundaries: ["renderbuffer contents cannot be read out of WebGL2; restored uninitialized"],
      })],
    };
  }

  function makeGlCanvas(gl: unknown): OffscreenCanvas {
    return {
      width: 64,
      height: 48,
      getContext: (kind: string) => (kind === "webgl2" ? gl : null),
    } as unknown as OffscreenCanvas;
  }

  function heldWorker() {
    const handleChannel = vi.fn(() => 0);
    const worker = makeWorker({
      kernel_dequeue_signal: () => 0,
      kernel_get_process_exit_signal: () => -1,
      kernel_handle_channel: handleChannel,
      kernel_set_current_tid: () => 0,
    });
    worker.testAuthority.configureScratchBoundaryHooksForTest({
      completeChannel: vi.fn(),
      completeChannelRaw: vi.fn(),
      relistenChannel: vi.fn(),
      synchronizeSharedMemoryForBoundary: vi.fn(),
    });
    worker.restoreGlFromCheckpoint(device(), () => {});
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const [channel] = worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid: 7,
      memory,
      channelOffsets: [0],
      pointerWidth: 4,
    });
    const view = new DataView(memory.buffer);
    view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Getpid, true);
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    worker.handleSyscall(channel);
    return { worker, handleChannel };
  }

  it("binds the sessions at once and hands the device back verbatim until the canvas arrives", () => {
    const worker = makeWorker();
    const gl = device();
    const reported: string[] = [];

    worker.restoreGlFromCheckpoint(gl, (line) => reported.push(line));

    expect(worker.gl.get(7, 2)).toBeDefined();
    expect(worker.gl.get(7, 2)!.gl).toBeNull();
    expect(worker.captureGlForCheckpoint()).toBe(gl);
    expect(reported.some((line) => line.includes("renderbuffer contents"))).toBe(true);
  });

  it("rebuilds the session when the CRTC's canvas attaches", () => {
    const worker = makeWorker();
    const gl = device();
    worker.restoreGlFromCheckpoint(gl, () => {});

    worker.attachKmsCanvas(1, makeGlCanvas(renderer()), undefined, { mode: "webgl2" });

    const binding = worker.gl.get(7, 2)!;
    expect(binding.gl).not.toBeNull();
    expect(binding.contextId).toBe(1);
    expect([...binding.programs.keys()]).toEqual([7]);
    // The session holds no DRM master, so it renders on the device renderer
    // without claiming the CRTC's canvas, and a new capture says so.
    expect(worker.captureGlForCheckpoint()).toEqual({
      ...gl,
      sessions: [{ ...gl.sessions[0]!, crtcId: null }],
    });
  });

  it("rebinds foreign textures under the names the guest holds", () => {
    const worker = makeWorker();
    const gl = device();
    const foreign = {
      name: 0x4000_0002, boId: 5, width: 2, height: 1, pixels: new Uint8Array(8),
      minFilter: 0x2600, magFilter: 0x2600, wrapS: 0x812f, wrapT: 0x812f,
    };
    const sessions = [{ ...gl.sessions[0]!, foreignTextures: [foreign], nextForeignTexId: 0x4000_0003 }];
    worker.restoreGlFromCheckpoint({ ...gl, sessions }, () => {});

    worker.attachKmsCanvas(1, makeGlCanvas(renderer()), undefined, { mode: "webgl2" });

    const binding = worker.gl.get(7, 2)!;
    expect(binding.foreignTextures.get(5)?.texId).toBe(0x4000_0002);
    expect(binding.nextForeignTexId).toBe(0x4000_0003);
    expect(worker.captureGlForCheckpoint().sessions[0]).toEqual({ ...sessions[0], crtcId: null });
  });

  it("rebinds a GPU-tier foreign texture as a view of its rebuilt buffer", () => {
    const worker = makeWorker();
    const gl = device();
    const foreign = {
      name: 0x6000_0005, boId: 9, width: 2, height: 1, pixels: null,
      minFilter: 0x2601, magFilter: 0x2601, wrapS: 0x812f, wrapT: 0x812f,
    };
    const restored: CheckpointGl = {
      gpuBos: [{ boId: 9, texId: 0x6000_0005, width: 2, height: 1, format: 0x34324241, pixels: new Uint8Array(8) }],
      sessions: [{ ...gl.sessions[0]!, foreignTextures: [foreign] }],
    };
    worker.restoreGlFromCheckpoint(restored, () => {});

    worker.attachKmsCanvas(1, makeGlCanvas(renderer()), undefined, { mode: "webgl2" });

    expect(worker.gl.gpuBo(9)?.texId).toBe(0x6000_0005);
    expect(worker.gl.get(7, 2)!.foreignTextures.get(9)?.texId).toBe(0x6000_0005);
    expect(worker.captureGlForCheckpoint().sessions[0]!.foreignTextures).toEqual([foreign]);
  });

  it("reports a renderer that cannot be had and leaves the device behind", () => {
    const worker = makeWorker();
    const reported: string[] = [];
    worker.restoreGlFromCheckpoint(device(), (line) => reported.push(line));

    worker.attachKmsCanvas(1, makeGlCanvas(null), undefined, { mode: "webgl2" });

    expect(reported.some((line) => line.includes("could not be rebuilt"))).toBe(true);
    expect(worker.gl.get(7, 2)!.gl).toBeNull();
  });

  it("reports a session that had a renderer and finds none here", () => {
    const worker = makeWorker();
    const reported: string[] = [];
    const gl = device();
    worker.restoreGlFromCheckpoint(
      { ...gl, sessions: [{ ...gl.sessions[0]!, surface: null, context: null, drawable: null }] },
      (line) => reported.push(line),
    );

    worker.attachKmsCanvas(1, makeGlCanvas(renderer()), undefined, { mode: "webgl2" });

    expect(reported.some((line) => line.includes("had a renderer when captured and has none here"))).toBe(true);
  });

  it("holds the restored process's syscalls until its canvas arrives", () => {
    const { worker, handleChannel } = heldWorker();
    // Served now, a GL call would meet a session with no context, which
    // the captured machine never answered.
    expect(handleChannel).not.toHaveBeenCalled();

    worker.attachKmsCanvas(1, makeGlCanvas(renderer()), undefined, { mode: "webgl2" });
    expect(handleChannel).toHaveBeenCalledTimes(1);
  });

  it("serves the held syscalls when the rebuild fails", () => {
    const { worker, handleChannel } = heldWorker();
    worker.attachKmsCanvas(1, makeGlCanvas(null), undefined, { mode: "webgl2" });
    expect(handleChannel).toHaveBeenCalledTimes(1);
  });

  it("binds a context-less session with nothing pending", () => {
    const worker = makeWorker();
    const gl: CheckpointGl = {
      gpuBos: [],
      sessions: [session({
        pid: 7, sessionId: 2, state: null, buffers: [], textures: [], renderbuffers: [],
        shaders: [], programs: [], vertexArrays: [], framebuffers: [],
      })],
    };

    worker.restoreGlFromCheckpoint(gl, () => {});

    expect(worker.gl.get(7, 2)).toBeDefined();
    expect(worker.captureGlForCheckpoint()).toEqual(gl);
  });
});
