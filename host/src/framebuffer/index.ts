export { FramebufferRegistry } from "./registry.js";
export {
  DEFAULT_POINTER_LOCK_MOUSE_SENSITIVITY,
  attachPointerLockMouse,
  createPcmAudioScheduler,
  injectChunkedMouseMotion,
  scalePointerLockMouseDelta,
} from "./browser-controls.js";
export type {
  FbBinding,
  FbBindingInput,
  FbChangeEvent,
  FbChangeListener,
  FbFormat,
  FbWriteListener,
} from "./registry.js";
export { attachCanvas } from "./canvas-renderer.js";
export type { CanvasAttachOpts } from "./canvas-renderer.js";
export type {
  AudioDrainSource,
  AudioOutputHandle,
  MouseEventSink,
  PcmAudioSchedulerOptions,
  PointerLockMouseHandle,
  PointerLockMouseOptions,
  ScalePointerLockMouseDeltaOptions,
} from "./browser-controls.js";
