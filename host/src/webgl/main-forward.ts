import { GlContextRegistry } from "./registry.js";
import { decodeAndDispatch } from "./bridge.js";

export interface ForwardWorkerLike {
  addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (e: MessageEvent) => void): void;
}

export type GlForwardMessage =
  | { type: "gl_forward_create_context"; pid: number }
  | { type: "gl_forward_destroy_context"; pid: number }
  | { type: "gl_forward_submit"; pid: number; bytes: Uint8Array }
  | { type: "gl_forward_unbind"; pid: number };

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
        return;
      }
      case "gl_forward_destroy_context": {
        b.gl = null;
        return;
      }
      case "gl_forward_submit": {
        if (!b.gl) return;
        b.cmdbufView = msg.bytes;
        decodeAndDispatch(b, 0, msg.bytes.byteLength);
        return;
      }
      case "gl_forward_unbind": {
        reg.unbind(pid);
        return;
      }
    }
  };

  worker.addEventListener("message", onMessage);
  return () => {
    worker.removeEventListener("message", onMessage);
    reg.unbind(pid);
  };
}
