import { attachKmsBitmapDisplay } from './kms-bitmap-display';

/** This realm receives device canvases and images, never guest address spaces. */
let attached = false;
globalThis.onmessage = (event: MessageEvent) => {
  if (attached) throw new Error('KMS bitmap display was already attached');
  attached = true;
  const { canvases, port } = event.data as { canvases: OffscreenCanvas[]; port: MessagePort };
  attachKmsBitmapDisplay(canvases, port);
};

// Only loaded module code can accept the transferred device canvases.
globalThis.postMessage({ type: 'loaded' });
