// A WebGL 2 test double for the kgpu GPU worker (Ruling R7), loaded by the
// worker the way an embedder's WebGL 2 factory is: the module exports
// `createWebGL2Context()`.
//
// WHY a model rather than a call log: the kgpu tests assert pixels a guest
// reads back, so the double must hold real RGBA8 storage per renderbuffer and
// implement what the kgpu WebGL 2 backend uses -- framebuffer/renderbuffer
// objects, clearColor, clear and readPixels -- with WebGL's conversion of a
// clear color to unsigned normalized bytes. Anything else throws, so a
// backend that starts using more of WebGL fails loudly here instead of
// passing against a no-op. Browsers verify the real thing (Task 8).
//
// Node's native TypeScript stripping loads this file in the GPU worker, so
// it uses only erasable syntax.

const FRAMEBUFFER = 0x8d40, RENDERBUFFER = 0x8d41, RGBA8 = 0x8058, COLOR_ATTACHMENT0 = 0x8ce0;
const FRAMEBUFFER_COMPLETE = 0x8cd5, FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT = 0x8cd7;
const RGBA = 0x1908, UNSIGNED_BYTE = 0x1401, COLOR_BUFFER_BIT = 0x4000;
const NO_ERROR = 0, INVALID_OPERATION = 0x0502, INVALID_VALUE = 0x0501;

interface Renderbuffer { width: number; height: number; pixels: Uint8Array | null; deleted: boolean }
interface Framebuffer { color: Renderbuffer | null; deleted: boolean }

export function createWebGL2Context(): { gl: unknown; canvas: EventTarget } {
  const canvas = new EventTarget();
  let framebuffer: Framebuffer | null = null;
  let renderbuffer: Renderbuffer | null = null;
  let clear: [number, number, number, number] = [0, 0, 0, 0];
  let error = NO_ERROR;
  let lost = false;
  const fail = (code: number) => { if (error === NO_ERROR) error = code; };
  const unorm = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  const gl = {
    createFramebuffer: (): Framebuffer => ({ color: null, deleted: false }),
    createRenderbuffer: (): Renderbuffer => ({ width: 0, height: 0, pixels: null, deleted: false }),
    deleteFramebuffer(fb: Framebuffer | null) { if (fb) fb.deleted = true; if (framebuffer === fb) framebuffer = null; },
    deleteRenderbuffer(rb: Renderbuffer | null) { if (rb) { rb.deleted = true; rb.pixels = null; } if (renderbuffer === rb) renderbuffer = null; },
    bindFramebuffer(target: number, fb: Framebuffer | null) {
      if (target !== FRAMEBUFFER || fb?.deleted) return fail(INVALID_OPERATION);
      framebuffer = fb;
    },
    bindRenderbuffer(target: number, rb: Renderbuffer | null) {
      if (target !== RENDERBUFFER || rb?.deleted) return fail(INVALID_OPERATION);
      renderbuffer = rb;
    },
    renderbufferStorage(target: number, format: number, width: number, height: number) {
      if (target !== RENDERBUFFER || !renderbuffer || format !== RGBA8) return fail(INVALID_OPERATION);
      if (width < 0 || height < 0) return fail(INVALID_VALUE);
      renderbuffer.width = width; renderbuffer.height = height;
      renderbuffer.pixels = new Uint8Array(width * height * 4);
    },
    framebufferRenderbuffer(target: number, attachment: number, rbTarget: number, rb: Renderbuffer | null) {
      if (target !== FRAMEBUFFER || attachment !== COLOR_ATTACHMENT0 || rbTarget !== RENDERBUFFER || !framebuffer) {
        return fail(INVALID_OPERATION);
      }
      framebuffer.color = rb;
    },
    checkFramebufferStatus(target: number): number {
      if (target !== FRAMEBUFFER || !framebuffer) return FRAMEBUFFER_COMPLETE; // the default framebuffer
      return framebuffer.color?.pixels ? FRAMEBUFFER_COMPLETE : FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
    },
    // The 1x1 default framebuffer and scissor/mask state are not modelled:
    // the backend must render into its own framebuffers with the defaults.
    viewport(_x: number, _y: number, _w: number, _h: number) {},
    disable(_capability: number) {},
    colorMask(_r: boolean, _g: boolean, _b: boolean, _a: boolean) {},
    pixelStorei(_name: number, _value: number) {},
    clearColor(r: number, g: number, b: number, a: number) { clear = [r, g, b, a]; },
    clear(mask: number) {
      const target = framebuffer?.color?.pixels;
      if (!target) return fail(INVALID_OPERATION);
      if (mask & COLOR_BUFFER_BIT) {
        const rgba = clear.map(unorm);
        for (let i = 0; i < target.length; i += 4) target.set(rgba, i);
      }
    },
    readPixels(x: number, y: number, w: number, h: number, format: number, type: number, out: Uint8Array) {
      const color = framebuffer?.color;
      if (!color?.pixels || format !== RGBA || type !== UNSIGNED_BYTE) return fail(INVALID_OPERATION);
      if (w < 0 || h < 0 || out.byteLength < w * h * 4) return fail(INVALID_VALUE);
      // Pixels outside the framebuffer are left untouched, as in WebGL.
      for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
        const sx = x + col, sy = y + row;
        if (sx < 0 || sy < 0 || sx >= color.width || sy >= color.height) continue;
        out.set(color.pixels.subarray((sy * color.width + sx) * 4, (sy * color.width + sx) * 4 + 4), (row * w + col) * 4);
      }
    },
    getError(): number { const e = error; error = NO_ERROR; return e; },
    isContextLost: (): boolean => lost,
  };
  const strict = new Proxy(gl, {
    get(target, key) {
      if (typeof key === 'string' && !(key in target)) throw new Error(`kgpu WebGL 2 double does not model ${key}`);
      return Reflect.get(target, key);
    },
  });
  // A test can lose the context the way a browser does.
  canvas.addEventListener('kgpu-test-lose', () => { lost = true; canvas.dispatchEvent(new Event('webglcontextlost')); });
  return { gl: strict, canvas };
}
