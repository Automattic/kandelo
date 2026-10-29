import { blitPresentTarget } from "./present-target.js";
import { prepareSurfaceCreation, validSurfaceCreation, type GlSurfaceCreation } from "./surface-create.js";
import { GlContextRegistry, type GlForwardChannel } from "./registry.js";
import { decodeAndDispatch, validateCommandBuffer } from "./bridge.js";
import { SubmitFrame, SubmitQueue } from "./submit-queue.js";
import { drainSubmitQueue } from "./submit-drain.js";
import { recordGlError } from "./errors.js";
import { runGlQuery } from "./query.js";
import { isFenceQuery, validFenceQuery, prepareFenceQuery, type PreparedFenceQuery } from "./fence-query.js";
import { querySurfaceCapabilities, surfaceCapabilityRenderer } from "./surface-capabilities.js";
import { QOP_SURFACE_CAPABILITIES, QOP_FINISH, QOP_FLUSH } from "./ops.js";
import { GlMuxer } from "./muxer.js";
import { prepareCurrentDrawable, resolveDrawableSurfaces, validCurrentDrawable, type GlDrawableBinding } from "./current.js";
import {
  completeGlForwardQuery, createGlForwardQueryMailbox, glForwardQueryCapacity,
  glForwardRequestPending, GL_FORWARD_QUERY_MAX_BYTES, prepareGlForwardQuery, retireGlForwardQuery,
  waitForGlForwardQuery,
} from "./main-forward-query.js";

// Multiple forwarded owners may share a canvas/native WebGL context.
const muxers = new WeakMap<WebGL2RenderingContext, GlMuxer>();
function muxer(gl: WebGL2RenderingContext): GlMuxer {
  let value = muxers.get(gl);
  if (!value) { value = new GlMuxer(gl); muxers.set(gl, value); }
  return value;
}

export interface ForwardWorkerLike {
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
}

export type GlForwardMessage =
  | { type: "gl_forward_create_context"; pid: number; sessionId: number; shareSessionId?: number; mailbox: SharedArrayBuffer }
  | { type: "gl_forward_create_surface"; pid: number; sessionId: number; surface: GlSurfaceCreation; mailbox: SharedArrayBuffer }
  | { type: "gl_forward_present"; pid: number; sessionId: number; mailbox: SharedArrayBuffer }
  | { type: "gl_forward_destroy_surface"; pid: number; sessionId: number; surfaceId: number }
  | { type: "gl_forward_make_current"; pid: number; sessionId: number; drawable: GlDrawableBinding; mailbox: SharedArrayBuffer }
  | { type: "gl_forward_destroy_context"; pid: number; sessionId: number }
  | { type: "gl_forward_submit"; pid: number; sessionId: number; bytes: Uint8Array }
  | { type: "gl_forward_query"; pid: number; sessionId: number; op: number; input: Uint8Array; mailbox: SharedArrayBuffer }
  | { type: "gl_forward_unbind"; pid: number; sessionId: number };

/** Kernel-worker adapter. Copied command/input bytes and bounded device
 * storage are the only data that may cross to the persistent main realm. */
export function createMainForwardChannel(
  port: { postMessage(message: GlForwardMessage): void }, pid: number, defaultSessionId = 0,
): GlForwardChannel {
  let mailbox: SharedArrayBuffer | null = null;
  function request(outLen: number, send: (mailbox: SharedArrayBuffer) => void) {
    try {
      mailbox ??= createGlForwardQueryMailbox();
      prepareGlForwardQuery(mailbox, outLen);
      send(mailbox);
      return waitForGlForwardQuery(mailbox);
    } catch {
      if (mailbox) retireGlForwardQuery(mailbox);
      return { rc: -5, bytes: new Uint8Array() };
    }
  }
  return {
    onCreateContext(sessionId = defaultSessionId, shareSessionId?: number) {
      if (shareSessionId !== undefined && (!Number.isInteger(shareSessionId) || shareSessionId < 0 || shareSessionId > 0xffff_ffff)) return -22;
      const { rc } = request(0, mailbox => {
        // Copy only the reviewed identity, never structurally compatible extras.
        const message: GlForwardMessage = { type: "gl_forward_create_context", pid, sessionId, mailbox };
        if (shareSessionId !== undefined) message.shareSessionId = shareSessionId;
        port.postMessage(message);
      });
      // An unacknowledged allocation can still have reached the renderer.
      // Ordered cleanup also covers a timeout racing native creation.
      if (rc !== 0) {
        try { port.postMessage({ type: "gl_forward_destroy_context", pid, sessionId }); }
        catch { /* The failed channel remains failed; no success is reported. */ }
      }
      return rc;
    },
    onCreateSurface(surface, sessionId = defaultSessionId) {
      const copy = {surfaceId:surface.surfaceId,kind:surface.kind,width:surface.width,height:surface.height,
        configId:surface.configId,targetBoId:surface.targetBoId};
      if (!validSurfaceCreation(copy) || copy.targetBoId !== 0) return {rc:-22,width:0,height:0};
      const result = request(8, mailbox => port.postMessage({type:"gl_forward_create_surface",pid,sessionId,surface:copy,mailbox}));
      if (result.rc !== 8 || result.bytes.byteLength !== 8) {
        try { port.postMessage({type:"gl_forward_destroy_surface",pid,sessionId,surfaceId:copy.surfaceId}); } catch { /* Failed channel stays failed. */ }
        return {rc:result.rc < 0 ? result.rc : -5,width:0,height:0};
      }
      const reply = new DataView(result.bytes.buffer,result.bytes.byteOffset,8);
      return {rc:0,width:reply.getUint32(0,true),height:reply.getUint32(4,true)};
    },
    onDestroySurface(surfaceId, sessionId = defaultSessionId) {
      port.postMessage({type:"gl_forward_destroy_surface",pid,sessionId,surfaceId});
    },
    onDestroyContext(sessionId = defaultSessionId) { port.postMessage({ type: "gl_forward_destroy_context", pid, sessionId }); },
    onMakeCurrent(drawable, sessionId = defaultSessionId) {
      // Copy only reviewed scalars. Spreading a structurally compatible
      // caller object could send extra guest-memory fields to browser main.
      const copy = {
        drawSurfaceId: drawable.drawSurfaceId, readSurfaceId: drawable.readSurfaceId,
        width: drawable.width, height: drawable.height,
      };
      if (!validCurrentDrawable(copy)) return -22;
      return request(0, mailbox => port.postMessage({
        type: "gl_forward_make_current", pid, sessionId, drawable: copy, mailbox,
      })).rc;
    },
    onPresent(sessionId = defaultSessionId) {
      return request(0, mailbox => port.postMessage({type:"gl_forward_present",pid,sessionId,mailbox})).rc;
    },
    onUnbind(sessionId) { port.postMessage({ type: "gl_forward_unbind", pid, sessionId }); },
    onSubmit(bytes, sessionId = defaultSessionId) { port.postMessage({ type: "gl_forward_submit", pid, sessionId, bytes: bytes.slice() }); },
    onQuery(op, input, outLen, sessionId = defaultSessionId) {
      if (input.byteLength > GL_FORWARD_QUERY_MAX_BYTES || !Number.isSafeInteger(outLen)
          || outLen < 0 || outLen > GL_FORWARD_QUERY_MAX_BYTES) {
        return { rc: -22, bytes: new Uint8Array() };
      }
      return request(outLen, mailbox =>
        port.postMessage({ type: "gl_forward_query", pid, sessionId, op, input: input.slice(), mailbox }));
    },
  };
}

export function setupMainForward(
  worker: ForwardWorkerLike,
  canvas: HTMLCanvasElement,
  pid: number,
): () => void {
  const reg = new GlContextRegistry();
  const queue = new SubmitQueue(undefined,
    binding => binding.gl ? reg.retainSubmitExecution(binding, muxer(binding.gl)) : null);

  const onMessage = (e: MessageEvent) => {
    const msg = e.data as GlForwardMessage;
    if (!msg || typeof msg !== "object" || msg.pid !== pid) return;
    if (!Number.isInteger(msg.sessionId) || msg.sessionId < 0 || msg.sessionId > 0xffff_ffff) return;
    let b = reg.get(pid, msg.sessionId);
    const capabilities = msg.type === "gl_forward_query" && msg.op === QOP_SURFACE_CAPABILITIES;
    if (!b && (msg.type === "gl_forward_create_context" || msg.type === "gl_forward_create_surface" || capabilities)) {
      try {
        if (!glForwardRequestPending(msg.mailbox)) return;
        if (capabilities && (glForwardQueryCapacity(msg.mailbox) !== 16 ||
            (msg as Extract<GlForwardMessage,{type:"gl_forward_query"}>).input.byteLength !== 0)) {
          completeGlForwardQuery(msg.mailbox,-22,new Uint8Array()); return;
        }
        if (!capabilities && glForwardQueryCapacity(msg.mailbox) !== (msg.type === "gl_forward_create_surface" ? 8 : 0))
          throw new RangeError("invalid creation reply");
        reg.bind({ pid, sessionId: msg.sessionId, cmdbufAddr: 0, cmdbufLen: 0 });
        b = reg.get(pid, msg.sessionId);
      } catch {
        try { completeGlForwardQuery(msg.mailbox, -5, new Uint8Array()); } catch { /* no reply authority */ }
        return;
      }
    }
    if (!b) {
      if (msg.type === "gl_forward_create_context" || msg.type === "gl_forward_query"
          || msg.type === "gl_forward_make_current" || msg.type === "gl_forward_create_surface" || msg.type === "gl_forward_present") {
        completeGlForwardQuery(msg.mailbox, -5, new Uint8Array());
      }
      return;
    }
    switch (msg.type) {
      case "gl_forward_create_surface": {
        try {
          if (!glForwardRequestPending(msg.mailbox)) return;
          if (glForwardQueryCapacity(msg.mailbox) !== 8 || !validSurfaceCreation(msg.surface) || msg.surface.targetBoId !== 0) {
            completeGlForwardQuery(msg.mailbox,-22,new Uint8Array()); return;
          }
          if (reg.getSurface(pid,msg.surface.surfaceId)) {
            completeGlForwardQuery(msg.mailbox,-16,new Uint8Array()); return;
          }
          const result = prepareSurfaceCreation(b,msg.surface,undefined,canvas,gl => {
            if (!reg.retryExecutionRetirements(gl)) throw new Error("Execution retirement remains pending");
            muxers.get(gl)?.captureCurrentErrors();
          });
          const prepared = result.prepared;
          if (!prepared) { completeGlForwardQuery(msg.mailbox,result.rc,new Uint8Array()); return; }
          try {
            const bytes = new Uint8Array(8), reply = new DataView(bytes.buffer);
            reply.setUint32(0,prepared.width,true); reply.setUint32(4,prepared.height,true);
            if (completeGlForwardQuery(msg.mailbox,8,bytes)) prepared.commit();
          } finally { prepared.cancel(); }
        } catch { try { completeGlForwardQuery(msg.mailbox,-5,new Uint8Array()); } catch { /* No reply authority. */ } }
        return;
      }
      case "gl_forward_destroy_surface": {
        if (b.surfaceId === msg.surfaceId) {
          if (b.gl) muxer(b.gl).invalidateCurrent();
          reg.destroySurface(pid,msg.sessionId);
        }
        return;
      }
      case "gl_forward_present": {
        try {
          if (!glForwardRequestPending(msg.mailbox)) return;
          if (glForwardQueryCapacity(msg.mailbox) !== 0) { completeGlForwardQuery(msg.mailbox,-22,new Uint8Array()); return; }
          if (!b.gl || b.gl.isContextLost() || !reg.retryExecutionRetirements(b.gl)) { completeGlForwardQuery(msg.mailbox,-5,new Uint8Array()); return; }
          muxer(b.gl).switchTo(b);
          if ((b.drawSurface ?? b.surface).kind !== 2 && (b.drawSurface ?? b.surface).presentTarget) blitPresentTarget(b);
          b.gl.flush();
          completeGlForwardQuery(msg.mailbox,0,new Uint8Array());
        } catch { try { completeGlForwardQuery(msg.mailbox,-5,new Uint8Array()); } catch { /* No reply authority. */ } }
        return;
      }
      case "gl_forward_make_current": {
        try {
          if (!glForwardRequestPending(msg.mailbox)) return;
          if (glForwardQueryCapacity(msg.mailbox) !== 0 || !validCurrentDrawable(msg.drawable)) {
            completeGlForwardQuery(msg.mailbox, -22, new Uint8Array());
            return;
          }
          if (!b.gl || b.gl.isContextLost()) {
            completeGlForwardQuery(msg.mailbox, -5, new Uint8Array());
            return;
          }
          const surfaces = msg.drawable.drawSurfaceId === 0 ? null
            : resolveDrawableSurfaces(reg,b,msg.drawable.drawSurfaceId,msg.drawable.readSurfaceId);
          if (msg.drawable.drawSurfaceId !== 0 && !surfaces) {
            completeGlForwardQuery(msg.mailbox,-22,new Uint8Array()); return;
          }
          if (!glForwardRequestPending(msg.mailbox)) return;
          if (!reg.retryExecutionRetirements(b.gl)) {
            completeGlForwardQuery(msg.mailbox,-5,new Uint8Array()); return;
          }
          muxer(b.gl).invalidateCurrent();
          const prepared = prepareCurrentDrawable(b, msg.drawable, surfaces ?? undefined);
          if (!prepared) {
            completeGlForwardQuery(msg.mailbox, -12, new Uint8Array());
            return;
          }
          try {
            if (completeGlForwardQuery(msg.mailbox, 0, new Uint8Array())) prepared.commit();
          } finally { prepared.cancel(); }
        } catch {
          try { completeGlForwardQuery(msg.mailbox, -5, new Uint8Array()); } catch { /* no reply authority */ }
        }
        return;
      }
      case "gl_forward_create_context": {
        let publishedHere = false;
        try {
          if (!glForwardRequestPending(msg.mailbox)) return;
          if (glForwardQueryCapacity(msg.mailbox) !== 0) throw new RangeError("invalid creation reply");
          if (b.gl) {
            completeGlForwardQuery(msg.mailbox, -16, new Uint8Array());
            return;
          }
          const shareSession = msg.shareSessionId;
          if (shareSession !== undefined && (!Number.isInteger(shareSession) || shareSession < 0 || shareSession > 0xffff_ffff)) {
            completeGlForwardQuery(msg.mailbox,-22,new Uint8Array()); return;
          }
          const source = shareSession === undefined ? undefined : reg.get(pid,shareSession);
          if (shareSession !== undefined && (!source || source === b || source.contextId === null || !source.gl)) {
            completeGlForwardQuery(msg.mailbox,-22,new Uint8Array()); return;
          }
          const gl = canvas.getContext("webgl2", {
            antialias: false,
            premultipliedAlpha: false,
            depth: true,
            stencil: true,
            preserveDrawingBuffer: true,
          }) as WebGL2RenderingContext | null;
          if (!gl || gl.isContextLost() || (b.surface.gl && b.surface.gl !== gl)) {
            completeGlForwardQuery(msg.mailbox, -19, new Uint8Array());
            return;
          }
          if (!reg.retryExecutionRetirements(gl)) {
            completeGlForwardQuery(msg.mailbox,-5,new Uint8Array()); return;
          }
          // Pavel's fluid sim renders the velocity/dye/pressure passes
          // into RGBA16F framebuffers and samples them with LINEAR
          // filtering during advection. Both require explicit extension
          // enablement on WebGL2 — the spec defines the storage formats
          // but defers renderability and filterability of float textures
          // to optional extensions.
          gl.getExtension("EXT_color_buffer_float");
          gl.getExtension("OES_texture_float_linear");
          gl.getExtension("EXT_float_blend");
          // The waiting worker can retire the request while native setup
          // runs. Do not publish a late context into that retired channel.
          if (!glForwardRequestPending(msg.mailbox)) return;
          b.gl = gl;
          b.contextId = msg.sessionId;
          publishedHere = true;
          if (source && !reg.shareObjects(pid,msg.sessionId,source.sessionId)) {
            reg.destroyContext(pid,msg.sessionId);
            completeGlForwardQuery(msg.mailbox,-19,new Uint8Array()); return;
          }
          b.shadow.viewport = [0, 0, canvas.width, canvas.height];
          b.shadow.scissor.rect = [0, 0, canvas.width, canvas.height];
          if (!completeGlForwardQuery(msg.mailbox, 0, new Uint8Array())) {
            reg.destroyContext(pid, msg.sessionId);
          }
        } catch {
          if (publishedHere && b.contextId !== null) reg.destroyContext(pid,msg.sessionId);
          try { completeGlForwardQuery(msg.mailbox, -5, new Uint8Array()); }
          catch { /* A malformed mailbox has no reply authority. */ }
        }
        return;
      }
      case "gl_forward_destroy_context": {
        if (b.gl) muxer(b.gl).invalidateCurrent();
        reg.destroyContext(pid, msg.sessionId);
        return;
      }
      case "gl_forward_submit": {
        if (!b.gl) return;
        try {
          const frame = new SubmitFrame(msg.bytes,0,msg.bytes.byteLength);
          if (frame.validate(validateCommandBuffer) < 0) { frame.discard(); recordGlError(b,0x502); return; }
          if (!reg.retryExecutionRetirements(b.gl)) { frame.discard(); recordGlError(b,0x502); return; }
          queue.enqueue(b, frame);
          if (drainSubmitQueue(queue, binding => binding.gl ? muxer(binding.gl) : null,
            (binding, offset, length) => decodeAndDispatch(binding, offset, length)) < 0) recordGlError(b,0x502);
        } catch { recordGlError(b,0x502); }
        return;
      }
      case "gl_forward_query": {
        let preparedFence: PreparedFenceQuery | undefined;
        try {
          if (!glForwardRequestPending(msg.mailbox)) return;
          if (msg.input.byteLength > GL_FORWARD_QUERY_MAX_BYTES) throw new RangeError("query input too long");
          const output = new Uint8Array(glForwardQueryCapacity(msg.mailbox));
          if (isFenceQuery(msg.op) && !validFenceQuery(msg.input,output.byteLength)) {
            completeGlForwardQuery(msg.mailbox,-22,new Uint8Array()); return;
          }
          if ((msg.op === QOP_FINISH || msg.op === QOP_FLUSH) && (msg.input.byteLength !== 0 || output.byteLength !== 0)) {
            completeGlForwardQuery(msg.mailbox,-22,new Uint8Array()); return;
          }
          if (b.gl && !reg.retryExecutionRetirements(b.gl)) {
            completeGlForwardQuery(msg.mailbox,-5,new Uint8Array()); return;
          }
          let rc: number;
          if (isFenceQuery(msg.op)) {
            preparedFence = prepareFenceQuery(b,msg.op,msg.input,output,
              gl => muxers.get(gl)?.captureCurrentErrors(),
              () => { if (b.gl) muxer(b.gl).switchTo(b); });
            rc = preparedFence.rc;
          } else if (capabilities) {
            if (msg.input.byteLength !== 0 || output.byteLength !== 16) { completeGlForwardQuery(msg.mailbox,-22,new Uint8Array()); return; }
            const gl = surfaceCapabilityRenderer(b,canvas);
            if (gl) muxers.get(gl)?.captureCurrentErrors();
            rc = querySurfaceCapabilities(gl,msg.input,output);
          } else {
            if (b.gl) muxer(b.gl).switchTo(b);
            rc = runGlQuery(b, msg.op, msg.input, output);
          }
          if (completeGlForwardQuery(msg.mailbox, rc, output)) preparedFence?.candidate?.publish();
        } catch {
          try { completeGlForwardQuery(msg.mailbox, -5, new Uint8Array()); }
          catch { /* Invalid internal mailbox: waiting worker fails on timeout. */ }
        } finally { preparedFence?.candidate?.cancel(); }
        return;
      }
      case "gl_forward_unbind": {
        const contexts = b.fences.contexts();
        if (b.gl) contexts.add(b.gl);
        for (const gl of contexts) muxers.get(gl)?.invalidateCurrent();
        queue.removeSession(pid, msg.sessionId);
        reg.unbind(pid, msg.sessionId);
        return;
      }
    }
  };

  worker.addEventListener("message", onMessage);
  return () => {
    worker.removeEventListener("message", onMessage);
    for (const b of reg.list()) {
      const contexts = b.fences.contexts();
      if (b.gl) contexts.add(b.gl);
      for (const gl of contexts) muxers.get(gl)?.invalidateCurrent();
    }
    queue.removePid(pid);
    reg.unbind(pid);
  };
}
