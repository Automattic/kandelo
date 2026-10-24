export { GlContextRegistry } from "./registry.js";
export type {
  GlBinding,
  GlBindingInput,
  GlChangeEvent,
  GlChangeListener,
  GlContextHandle,
  GlForwardChannel,
  GlSurfaceHandle,
} from "./registry.js";
export { setupMainForward, createMainForwardChannel } from "./main-forward.js";
export type { ForwardWorkerLike, GlForwardMessage } from "./main-forward.js";
