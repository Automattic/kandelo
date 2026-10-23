import { GlContextRegistry, type GlForwardChannel } from "./registry.js";
import { decodeAndDispatch } from "./bridge.js";
import { runGlQuery } from "./query.js";
import { GlMuxer } from "./muxer.js";
import { applyCurrentDrawable, validCurrentDrawable, type GlDrawableBinding } from "./current.js";
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
  | { type: "gl_forward_create_context"; pid: number; sessionId: number; mailbox: SharedArrayBuffer }
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
    onCreateContext(sessionId = defaultSessionId) {
      const { rc } = request(0, mailbox =>
        port.postMessage({ type: "gl_forward_create_context", pid, sessionId, mailbox }));
      // An unacknowledged allocation can still have reached the renderer.
      // Ordered cleanup also covers a timeout racing native creation.
      if (rc !== 0) {
        try { port.postMessage({ type: "gl_forward_destroy_context", pid, sessionId }); }
        catch { /* The failed channel remains failed; no success is reported. */ }
      }
      return rc;
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

  const onMessage = (e: MessageEvent) => {
    const msg = e.data as GlForwardMessage;
    if (!msg || typeof msg !== "object" || msg.pid !== pid) return;
    if (!Number.isInteger(msg.sessionId) || msg.sessionId < 0 || msg.sessionId > 0xffff_ffff) return;
    let b = reg.get(pid, msg.sessionId);
    if (!b && msg.type === "gl_forward_create_context") {
      try {
        if (!glForwardRequestPending(msg.mailbox)) return;
        if (glForwardQueryCapacity(msg.mailbox) !== 0) throw new RangeError("invalid creation reply");
        reg.bind({ pid, sessionId: msg.sessionId, cmdbufAddr: 0, cmdbufLen: 0 });
        b = reg.get(pid, msg.sessionId);
      } catch {
        try { completeGlForwardQuery(msg.mailbox, -5, new Uint8Array()); } catch { /* no reply authority */ }
        return;
      }
    }
    if (!b) {
      if (msg.type === "gl_forward_create_context" || msg.type === "gl_forward_query"
          || msg.type === "gl_forward_make_current") {
        completeGlForwardQuery(msg.mailbox, -5, new Uint8Array());
      }
      return;
    }
    switch (msg.type) {
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
          if (!glForwardRequestPending(msg.mailbox)) return;
          const previous = { drawable: b.currentDrawable, initialized: b.hasBeenCurrent,
            viewport: b.shadow.viewport, scissor: b.shadow.scissor.rect, fbo: b.shadow.fbo, readFbo: b.shadow.readFbo };
          muxer(b.gl).invalidateCurrent();
          if (!applyCurrentDrawable(b, msg.drawable)) {
            completeGlForwardQuery(msg.mailbox, -12, new Uint8Array());
            return;
          }
          if (!completeGlForwardQuery(msg.mailbox, 0, new Uint8Array())) {
            // A caller that timed out did not commit a new kernel binding.
            // Roll back before processing any commands it sends afterwards.
            b.currentDrawable = previous.drawable; b.hasBeenCurrent = previous.initialized;
            b.shadow.viewport = previous.viewport; b.shadow.scissor.rect = previous.scissor;
            b.shadow.fbo = previous.fbo; b.shadow.readFbo = previous.readFbo;
          }
        } catch {
          try { completeGlForwardQuery(msg.mailbox, -5, new Uint8Array()); } catch { /* no reply authority */ }
        }
        return;
      }
      case "gl_forward_create_context": {
        try {
          if (!glForwardRequestPending(msg.mailbox)) return;
          if (glForwardQueryCapacity(msg.mailbox) !== 0) throw new RangeError("invalid creation reply");
          if (b.gl) {
            completeGlForwardQuery(msg.mailbox, -16, new Uint8Array());
            return;
          }
          const gl = canvas.getContext("webgl2", {
            antialias: false,
            premultipliedAlpha: false,
            depth: true,
            stencil: true,
            preserveDrawingBuffer: true,
          }) as WebGL2RenderingContext | null;
          if (!gl || gl.isContextLost()) {
            completeGlForwardQuery(msg.mailbox, -19, new Uint8Array());
            return;
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
          b.shadow.viewport = [0, 0, canvas.width, canvas.height];
          b.shadow.scissor.rect = [0, 0, canvas.width, canvas.height];
          if (!completeGlForwardQuery(msg.mailbox, 0, new Uint8Array())) {
            reg.destroyContext(pid, msg.sessionId);
          }
        } catch {
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
        muxer(b.gl).switchTo(b);
        b.cmdbufView = msg.bytes;
        decodeAndDispatch(b, 0, msg.bytes.byteLength);
        return;
      }
      case "gl_forward_query": {
        try {
          if (msg.input.byteLength > GL_FORWARD_QUERY_MAX_BYTES) throw new RangeError("query input too long");
          const output = new Uint8Array(glForwardQueryCapacity(msg.mailbox));
          if (b.gl) muxer(b.gl).switchTo(b);
          const rc = runGlQuery(b, msg.op, msg.input, output);
          completeGlForwardQuery(msg.mailbox, rc, output);
        } catch {
          try { completeGlForwardQuery(msg.mailbox, -5, new Uint8Array()); }
          catch { /* Invalid internal mailbox: waiting worker fails on timeout. */ }
        }
        return;
      }
      case "gl_forward_unbind": {
        if (b.gl) muxer(b.gl).invalidateCurrent();
        reg.unbind(pid, msg.sessionId);
        return;
      }
    }
  };

  worker.addEventListener("message", onMessage);
  return () => {
    worker.removeEventListener("message", onMessage);
    for (const b of reg.list()) if (b.gl) muxer(b.gl).invalidateCurrent();
    reg.unbind(pid);
  };
}
