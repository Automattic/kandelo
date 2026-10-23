import { GlContextRegistry, type GlForwardChannel } from "./registry.js";
import { decodeAndDispatch } from "./bridge.js";
import { runGlQuery } from "./query.js";
import { GlMuxer } from "./muxer.js";
import {
  completeGlForwardQuery, createGlForwardQueryMailbox, glForwardQueryCapacity,
  GL_FORWARD_QUERY_MAX_BYTES, prepareGlForwardQuery, retireGlForwardQuery,
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
  | { type: "gl_forward_create_context"; pid: number }
  | { type: "gl_forward_destroy_context"; pid: number }
  | { type: "gl_forward_submit"; pid: number; bytes: Uint8Array }
  | { type: "gl_forward_query"; pid: number; op: number; input: Uint8Array; mailbox: SharedArrayBuffer }
  | { type: "gl_forward_unbind"; pid: number };

/** Kernel-worker adapter. Copied command/input bytes and bounded device
 * storage are the only data that may cross to the persistent main realm. */
export function createMainForwardChannel(
  port: { postMessage(message: GlForwardMessage): void }, pid: number,
): GlForwardChannel {
  let mailbox: SharedArrayBuffer | null = null;
  return {
    onCreateContext() { port.postMessage({ type: "gl_forward_create_context", pid }); },
    onDestroyContext() { port.postMessage({ type: "gl_forward_destroy_context", pid }); },
    onSubmit(bytes) { port.postMessage({ type: "gl_forward_submit", pid, bytes: bytes.slice() }); },
    onQuery(op, input, outLen) {
      if (input.byteLength > GL_FORWARD_QUERY_MAX_BYTES || !Number.isSafeInteger(outLen)
          || outLen < 0 || outLen > GL_FORWARD_QUERY_MAX_BYTES) {
        return { rc: -22, bytes: new Uint8Array() };
      }
      try {
        mailbox ??= createGlForwardQueryMailbox();
        prepareGlForwardQuery(mailbox, outLen);
        port.postMessage({ type: "gl_forward_query", pid, op, input: input.slice(), mailbox });
        return waitForGlForwardQuery(mailbox);
      } catch {
        if (mailbox) retireGlForwardQuery(mailbox);
        return { rc: -5, bytes: new Uint8Array() };
      }
    },
  };
}

export function setupMainForward(
  worker: ForwardWorkerLike,
  canvas: HTMLCanvasElement,
  pid: number,
): () => void {
  const reg = new GlContextRegistry();
  reg.bind({ pid, cmdbufAddr: 0, cmdbufLen: 0 });

  const onMessage = (e: MessageEvent) => {
    const msg = e.data as GlForwardMessage;
    if (!msg || typeof msg !== "object" || msg.pid !== pid) return;
    const b = reg.get(pid);
    if (!b) return;
    switch (msg.type) {
      case "gl_forward_create_context": {
        const gl = canvas.getContext("webgl2", {
          antialias: false,
          premultipliedAlpha: false,
          depth: true,
          stencil: true,
          preserveDrawingBuffer: true,
        }) as WebGL2RenderingContext | null;
        if (gl) {
          // Pavel's fluid sim renders the velocity/dye/pressure passes
          // into RGBA16F framebuffers and samples them with LINEAR
          // filtering during advection. Both require explicit extension
          // enablement on WebGL2 — the spec defines the storage formats
          // but defers renderability and filterability of float textures
          // to optional extensions.
          gl.getExtension("EXT_color_buffer_float");
          gl.getExtension("OES_texture_float_linear");
          gl.getExtension("EXT_float_blend");
        }
        b.gl = gl;
        b.shadow.viewport = [0, 0, canvas.width, canvas.height];
        b.shadow.scissor.rect = [0, 0, canvas.width, canvas.height];
        return;
      }
      case "gl_forward_destroy_context": {
        if (b.gl) muxer(b.gl).invalidateCurrent();
        reg.destroyContext(pid);
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
        reg.unbind(pid);
        return;
      }
    }
  };

  worker.addEventListener("message", onMessage);
  return () => {
    worker.removeEventListener("message", onMessage);
    const gl = reg.get(pid)?.gl;
    if (gl) muxer(gl).invalidateCurrent();
    reg.unbind(pid);
  };
}
