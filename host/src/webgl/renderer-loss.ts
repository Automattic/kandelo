/**
 * Graphics reset reporting: a lost WebGL renderer is the GLES "graphics
 * reset" of EXT_robustness/KHR_robustness section 2.6 and the EGL "power
 * management event" of EGL 1.5 section 2.7.
 *
 * WebGL loses a context (WebGL 1.0 section 5.15.2) on a GPU reset, a driver
 * or GPU-process crash, or resource pressure. Every native object of the
 * lost context is invalid, including after a later restoration of the same
 * context object, which happens when a listener prevented the default of
 * `webglcontextlost` (the KMS presenter canvases do). So a binding's loss is
 * sticky: it is recorded when the host observes `isContextLost()` or when a
 * loss event fired on the renderer since the binding first used it, and it
 * never clears. The binding's guest context must be destroyed and recreated.
 *
 * Detection costs a property read and the native `isContextLost()` boolean
 * on the host entry points that already exist (submit, query, present,
 * make-current); the guest learns the loss from their `ENODEV` replies, as a
 * Linux DRM client learns of an unplugged device, and answers
 * glGetGraphicsResetStatus from that state with no extra round trip.
 */

type LossCounter = { count: number };
type LossBaseline = { gl: WebGL2RenderingContext; counter: LossCounter; count: number; lost: boolean };

/** -ENODEV: the binding's renderer was lost; nothing was executed. */
export const RENDERER_LOST = -19;

const counters = new WeakMap<object, LossCounter>();
const baselines = new WeakMap<object, LossBaseline>();

type LossEventTarget = { addEventListener?: (type: string, listener: () => void) => void };

/** One loss counter per renderer, fed by its canvas' loss events. Hosts whose
 * renderer has no event target (a Node embedder) rely on isContextLost(). */
function lossCounter(gl: WebGL2RenderingContext): LossCounter {
  let counter = counters.get(gl);
  if (counter) return counter;
  const created: LossCounter = { count: 0 };
  counters.set(gl, created);
  const canvas = (gl as { canvas?: unknown }).canvas as LossEventTarget | null | undefined;
  if (canvas && typeof canvas.addEventListener === "function")
    canvas.addEventListener("webglcontextlost", () => { created.count += 1; });
  return created;
}

/** How many losses this renderer has reported since the host first asked.
 * Native objects created before a later loss belong to the lost generation:
 * they are gone even after the context object is restored, so cleanup must
 * not treat a refused deletion of one as a live-renderer fault. */
export function rendererLossCount(gl: WebGL2RenderingContext): number {
  return lossCounter(gl).count;
}

/** Start observing a binding's renderer: losses before this call belong to
 * earlier owners of the same (since restored) context object. */
export function observeRendererLoss(b: { gl: WebGL2RenderingContext | null }): void {
  const gl = b.gl;
  if (!gl) return;
  const existing = baselines.get(b);
  if (existing?.gl === gl) return;
  const counter = lossCounter(gl);
  baselines.set(b, { gl, counter, count: counter.count, lost: !!existing?.lost });
}

/** True once the binding's renderer has been lost. */
export function rendererLost(b: { gl: WebGL2RenderingContext | null }): boolean {
  const gl = b.gl;
  if (!gl) return false;
  let baseline = baselines.get(b);
  if (!baseline || baseline.gl !== gl) { observeRendererLoss(b); baseline = baselines.get(b)!; }
  if (baseline.lost) return true;
  if (gl.isContextLost() || baseline.counter.count !== baseline.count) baseline.lost = true;
  return baseline.lost;
}

/** A validation divergence or native OOM loses only the guilty logical
 * context. Do not lose the physical renderer shared by unrelated sessions. */
export function markRendererReset(b: { gl: WebGL2RenderingContext | null }): void {
  observeRendererLoss(b);
  const baseline = baselines.get(b);
  if (baseline) baseline.lost = true;
}
