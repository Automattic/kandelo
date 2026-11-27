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
 * A retained presentation watches both the default drawing buffer and its
 * source framebuffer's storage. A 2D texture upload to another bound
 * object or a draw to a framebuffer with disjoint attachments changes
 * neither. Check actual native bindings before exempting a write. Unknown
 * operations (including extension methods) invalidate the presentation.
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
  "linkProgram", "pauseTransformFeedback", "pixelStorei", "polygonOffset", "readPixels",
  "resumeTransformFeedback", "sampleCoverage", "samplerParameterf", "samplerParameteri", "scissor",
  "shaderSource", "stencilFunc", "stencilFuncSeparate", "stencilMask", "stencilMaskSeparate",
  "stencilOp", "stencilOpSeparate", "transformFeedbackVaryings",
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

type Epoch = {
  count: number;
  /** Current source attachments, held weakly so a retired BO can be reclaimed. */
  source?: WeakSet<object>;
  /** Proven disjoint since the last attachment mutation. */
  otherFramebuffers?: WeakSet<object>;
};
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

/** Snapshot the storage attached to a non-default framebuffer while it
 * is bound. Respecifying or deleting *any* attachment could make the FBO
 * incomplete, even when the selected read buffer uses a different one. */
function attachments(gl: WebGL2RenderingContext, target: number): object[] | null {
  if (typeof gl.getFramebufferAttachmentParameter !== "function") return null;
  const count = gl.getParameter(0x8cdf); // MAX_COLOR_ATTACHMENTS
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) return null;
  const storage: object[] = [];
  const slots = [0x8d00, 0x8d20]; // DEPTH_ATTACHMENT, STENCIL_ATTACHMENT
  for (let color = 0; color < count; color++) slots.push(0x8ce0 + color);
  for (const attachment of slots) {
    const type = gl.getFramebufferAttachmentParameter(target, attachment, 0x8cd0);
    if (type === 0) continue;
    if (type !== 0x1702 && type !== 0x8d41) return null;
    const object = gl.getFramebufferAttachmentParameter(target, attachment, 0x8cd1);
    if (!object || typeof object !== "object") return null;
    storage.push(object);
  }
  return storage;
}

export function scanoutAttachments(gl: WebGL2RenderingContext): WeakSet<object> | undefined {
  const storage = attachments(gl, 0x8ca8); // READ_FRAMEBUFFER
  return storage?.length ? new WeakSet(storage) : undefined;
}

function writesElsewhere(gl: WebGL2RenderingContext, epoch: Epoch, name: string, args: unknown[]): boolean {
  const first = args[0];
  const sources = epoch.source;
  if (!sources) return false;
  if (name === "deleteTexture") return !!first && typeof first === "object" && !sources.has(first);
  // WebIDL number coercion can run user code and rebind a selector during
  // the native call. Only exempt primitive scalars and genuine pixel views
  // in their buffer argument slot. Other overloads keep the ordinary epoch.
  const upload = name === "texImage2D" || name === "texSubImage2D";
  if (!args.every((arg, i) => typeof arg === "number"
      || (upload && i === 8 && (arg === null || ArrayBuffer.isView(arg))))) return false;
  if (name.startsWith("tex")) {
    if (first !== 0x0de1) return false;
    const texture = gl.getParameter(0x8069); // TEXTURE_BINDING_2D on the active unit
    return !!texture && typeof texture === "object" && !sources.has(texture);
  }
  const fbo = gl.getParameter(0x8ca6); // default DRAW_FRAMEBUFFER is visible
  if (!fbo || typeof fbo !== "object") return false;
  if (epoch.otherFramebuffers?.has(fbo)) return true;
  const storage = attachments(gl, 0x8ca9);
  if (!storage || storage.some(object => sources.has(object))) return false;
  (epoch.otherFramebuffers ??= new WeakSet()).add(fbo);
  return true;
}

function counted(epoch: Epoch, original: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  return function countedWrite(this: unknown, ...args: unknown[]): unknown {
    epoch.count++;
    epoch.source = undefined;
    epoch.otherFramebuffers = undefined;
    return Reflect.apply(original, this, args);
  };
}

function trackExtension(extension: object, epoch: Epoch): void {
  if (wrapped.has(extension)) return;
  wrapped.add(extension);
  for (const [name, original] of methods(extension))
    Object.defineProperty(extension, name, { value: counted(epoch, original), configurable: true, writable: true });
}

function track(gl: WebGL2RenderingContext): Epoch {
  const epoch: Epoch = { count: 0 };
  epochs.set(gl, epoch);
  for (const [name, original] of methods(gl)) {
    if (["texImage2D", "texSubImage2D", "deleteTexture", "texParameteri", "texParameterf", "drawArrays", "drawElements"].includes(name)) {
      const value = function(this: unknown, ...args: unknown[]) {
        let elsewhere = false;
        if (this === gl && epoch.source) {
          try { elsewhere = writesElsewhere(gl, epoch, name, args); }
          catch { /* Incomplete native introspection requires a fresh presentation. */ }
        }
        if (!elsewhere) epoch.count++;
        return Reflect.apply(original, this, args);
      };
      Object.defineProperty(gl, name, { value, configurable: true, writable: true });
      continue;
    }
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

export function contextWriteEpoch(gl: WebGL2RenderingContext): number {
  return (epochs.get(gl) ?? track(gl)).count;
}

/** Each new direct blit replaces the set of native images it observed.
 * Advancing the epoch also invalidates other outputs on the same context. */
export function observeScanoutSource(gl: WebGL2RenderingContext, sources?: WeakSet<object>): void {
  const epoch = epochs.get(gl) ?? track(gl);
  epoch.source = sources;
  epoch.otherFramebuffers = undefined;
  epoch.count++;
}
