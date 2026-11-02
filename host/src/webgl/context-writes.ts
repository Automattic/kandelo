/**
 * Write epochs of native WebGL contexts.
 *
 * KMS presents a GPU-tier framebuffer by blitting it to the canvas of the
 * context that owns it (kms-scanout.ts). The vblank pump does that 60 times
 * a second whether or not anything changed. Skipping a blit is correct only
 * if neither its source (the framebuffer's storage) nor its destination (the
 * canvas' drawing buffer) has been written since the last one, and the
 * drawing buffer has more writers than the image write counts of
 * image-writes.ts follow: a GL session presenting to the same canvas, the
 * CRTC color stage, a dark CRTC's clear, any host utility that borrows the
 * context.
 *
 * So this epoch does not enumerate writers. It counts every call on the
 * context that is not on a fixed list of calls that cannot change the pixels
 * of any texture, renderbuffer or drawing buffer (state setters, binds,
 * queries, buffer data, object creation, program work, readPixels). A method
 * this list does not name, including one a future engine adds, counts as a
 * write. An extension object returned by getExtension after tracking began
 * counts every one of its calls as a write, since extensions add draw entry
 * points (WEBGL_multi_draw and friends).
 *
 * Tracking installs an own wrapper for each counted method on the context
 * object itself, so every caller that reaches the context, the bridge, host
 * utilities and an embedder alike, passes through it. The count advances
 * before the native call, so a call that throws after a native effect still
 * counted. Tracking starts on the first query: writes before that are
 * reflected in whatever the first presentation shows. A caller that captured
 * a bare method before tracking began would bypass it; host code calls
 * methods on the context (directly or through Reflect.apply), and the only
 * extensions it requests at context creation have no methods.
 *
 * The epoch says nothing about a lost context: callers compare loss counts
 * (renderer-loss.ts) as well.
 */

/** Calls that change no texel of any texture or renderbuffer and nothing in
 * the drawing buffer. readPixels writes client memory or a pack buffer, and
 * buffer objects are never presented or read back as images. */
const PURE = new Set([
  "activeTexture", "attachShader", "beginQuery", "beginTransformFeedback", "bindAttribLocation",
  "bindBuffer", "bindBufferBase", "bindBufferRange", "bindFramebuffer", "bindRenderbuffer",
  "bindSampler", "bindTexture", "bindTransformFeedback", "bindVertexArray",
  "blendColor", "blendEquation", "blendEquationSeparate", "blendFunc", "blendFuncSeparate",
  "bufferData", "bufferSubData", "checkFramebufferStatus", "clearColor", "clearDepth", "clearStencil",
  "clientWaitSync", "colorMask", "compileShader", "copyBufferSubData",
  "createBuffer", "createFramebuffer", "createProgram", "createQuery", "createRenderbuffer",
  "createSampler", "createShader", "createTexture", "createTransformFeedback", "createVertexArray",
  "cullFace", "deleteBuffer", "deleteProgram", "deleteQuery", "deleteSampler", "deleteShader",
  "deleteSync", "deleteTransformFeedback", "deleteVertexArray", "depthFunc", "depthMask", "depthRange",
  "detachShader", "disable", "disableVertexAttribArray", "drawBuffers", "enable", "enableVertexAttribArray",
  "endQuery", "endTransformFeedback", "fenceSync", "finish", "flush", "frontFace", "hint", "lineWidth",
  "linkProgram", "pauseTransformFeedback", "pixelStorei", "polygonOffset", "readBuffer", "readPixels",
  "resumeTransformFeedback", "sampleCoverage", "samplerParameterf", "samplerParameteri", "scissor",
  "shaderSource", "stencilFunc", "stencilFuncSeparate", "stencilMask", "stencilMaskSeparate",
  "stencilOp", "stencilOpSeparate", "texParameterf", "texParameteri", "transformFeedbackVaryings",
  "uniformBlockBinding", "useProgram", "validateProgram", "vertexAttribDivisor", "vertexAttribIPointer",
  "vertexAttribPointer", "viewport", "waitSync",
]);

/** Queries (get*, is*), uniform and constant-attribute setters. getExtension
 * is not one of them: it hands out objects with their own draw calls. */
function pure(name: string): boolean {
  if (PURE.has(name)) return true;
  if (name === "getExtension") return false;
  return /^(get|is)[A-Z]/.test(name) || /^uniform(Matrix)?[1-4]/.test(name) || /^vertexAttribI?[1-4]/.test(name);
}

type Epoch = { count: number };
const epochs = new WeakMap<object, Epoch>();
const wrapped = new WeakSet<object>();

/** Own function-valued members of `target` and its prototypes, by name. */
function methods(target: object): Map<string, (...args: unknown[]) => unknown> {
  const found = new Map<string, (...args: unknown[]) => unknown>();
  for (let object: object | null = target; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const name of Object.getOwnPropertyNames(object)) {
      if (name === "constructor" || found.has(name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      if (descriptor && "value" in descriptor && typeof descriptor.value === "function") found.set(name, descriptor.value);
    }
  }
  return found;
}

function counted(epoch: Epoch, original: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  return function countedWrite(this: unknown, ...args: unknown[]): unknown {
    epoch.count++;
    return Reflect.apply(original, this, args);
  };
}

function trackExtension(extension: object, epoch: Epoch): void {
  if (wrapped.has(extension)) return;
  wrapped.add(extension);
  for (const [name, original] of methods(extension))
    Object.defineProperty(extension, name, { value: counted(epoch, original), configurable: true, writable: true });
}

function track(gl: object): Epoch {
  const epoch: Epoch = { count: 0 };
  epochs.set(gl, epoch);
  for (const [name, original] of methods(gl)) {
    if (pure(name)) continue;
    const value = name === "getExtension"
      ? function trackedExtension(this: unknown, ...args: unknown[]): unknown {
        const extension = Reflect.apply(original, this, args);
        if (extension !== null && typeof extension === "object") trackExtension(extension, epoch);
        return extension;
      }
      : counted(epoch, original);
    Object.defineProperty(gl, name, { value, configurable: true, writable: true });
  }
  return epoch;
}

/** The number of possibly pixel-changing calls made on `gl` since tracking
 * began; the first call begins tracking. Equal values bracket an interval
 * in which no texture, renderbuffer or drawing buffer of `gl` was written. */
export function contextWriteEpoch(gl: WebGL2RenderingContext): number {
  return (epochs.get(gl) ?? track(gl)).count;
}
