/** Disposable browser display. Its port admits only bounded independent device
 * images. A retirement acknowledgement follows every consumed frame and clears
 * both bitmaprenderer-owned surfaces before the parent terminates this realm. */
export function attachKmsBitmapDisplay(canvases: OffscreenCanvas[], port: MessagePort): void {
  if (canvases.length < 1 || canvases.length > 2) throw new Error('Invalid KMS bitmap planes');
  const contexts = canvases.map(canvas => {
    const context = canvas.getContext('bitmaprenderer');
    if (!context) throw new Error('KMS bitmap display requires bitmaprenderer');
    return context;
  });
  let last = 0;
  port.onmessage = event => {
    const value = event.data;
    if (value?.type === 'retire') {
      if (value.sequence !== last) throw new Error('Invalid KMS bitmap retirement sequence');
      for (const context of contexts) context.transferFromImageBitmap(null);
      port.postMessage({ type: 'retired', sequence: last });
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
      return;
    }
    const frames: unknown[] = Array.isArray(value?.frames) ? value.frames : [];
    try {
      const { type, sequence, planes } = value ?? {};
      if (type !== 'frame' || !Number.isSafeInteger(sequence) || sequence !== last + 1
          || !frames.length || frames.length > contexts.length
          || !Array.isArray(planes) || planes.length !== frames.length
          || new Set(planes).size !== planes.length
          || planes.some(plane => !Number.isInteger(plane) || plane < 0 || plane >= contexts.length)) {
        throw new Error('Invalid KMS bitmap frame');
      }
      // Validate the whole bundle before consuming any plane.
      for (const frame of frames) {
        if (!(frame instanceof ImageBitmap) || frame.width < 1 || frame.width > 3840
            || frame.height < 1 || frame.height > 2160) throw new Error('Invalid KMS bitmap extent');
      }
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i] as ImageBitmap;
        const plane = planes[i];
        if (canvases[plane].width !== frame.width) canvases[plane].width = frame.width;
        if (canvases[plane].height !== frame.height) canvases[plane].height = frame.height;
        contexts[plane].transferFromImageBitmap(frame);
      }
      last = sequence;
      port.postMessage({ type: 'ack', sequence });
    } finally {
      // Also close malformed/unconsumed siblings. Native transfer consumes an
      // image; closing a consumed image is harmless.
      for (const frame of frames) if (frame instanceof ImageBitmap) frame.close();
    }
  };
  port.onmessageerror = () => { throw new Error('Invalid KMS bitmap display message'); };
  port.start();
}
