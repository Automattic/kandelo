import { KmsCursorPlane, type KmsCursorUpdate } from "./cursor-plane.js";

function validateCursor(value: KmsCursorUpdate): void {
  const { cursor, width, height, composited } = value;
  if (!cursor || !Number.isInteger(width) || width < 1 || width > 3840
      || !Number.isInteger(height) || height < 1 || height > 2160
      || typeof composited !== 'boolean'
      || !Number.isSafeInteger(cursor.version) || cursor.version < 0
      || !Number.isSafeInteger(cursor.x) || !Number.isSafeInteger(cursor.y)
      || !Number.isInteger(cursor.width) || cursor.width < 0 || cursor.width > 64
      || !Number.isInteger(cursor.height) || cursor.height < 0 || cursor.height > 64
      || (cursor.pixels !== null && (composited || cursor.width === 0 || cursor.height === 0
        || !(cursor.pixels instanceof Uint8ClampedArray) || !(cursor.pixels.buffer instanceof ArrayBuffer)
        || cursor.pixels.buffer.byteLength !== cursor.pixels.byteLength
        || cursor.pixels.byteLength !== cursor.width * cursor.height * 4))) {
    throw new Error('Invalid KMS cursor update');
  }
}

/** Disposable browser display. Only a primary plane needs a bitmap snapshot.
 * The display draws the small cursor image at its authoritative scanout
 * coordinates and retires both surfaces behind the same ordered fence. */
export function attachKmsBitmapDisplay(canvases: OffscreenCanvas[], port: MessagePort): void {
  if (canvases.length < 1 || canvases.length > 2) throw new Error('Invalid KMS bitmap planes');
  const [canvas, cursorCanvas] = canvases;
  const context = canvas.getContext('bitmaprenderer');
  if (!context) throw new Error('KMS bitmap display requires bitmaprenderer');
  const plane = cursorCanvas ? new KmsCursorPlane(cursorCanvas) : undefined;
  let last = 0;
  let lastCursor: KmsCursorUpdate | undefined;
  const restoreCursor = () => {
    if (lastCursor) {
      const { cursor, width, height, composited } = lastCursor;
      plane?.present(cursor, width, height, composited);
    }
  };
  cursorCanvas?.addEventListener('contextrestored', restoreCursor);

  port.onmessage = event => {
    const value = event.data;
    if (value?.type === 'retire') {
      if (value.sequence !== last) throw new Error('Invalid KMS bitmap retirement sequence');
      context.transferFromImageBitmap(null);
      plane?.clear();
      lastCursor = undefined;
      cursorCanvas?.removeEventListener('contextrestored', restoreCursor);
      port.postMessage({ type: 'retired', sequence: last });
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
      return;
    }
    const { type, sequence, frame, cursor, position } = value ?? {};
    try {
      if (type !== 'frame' || !Number.isSafeInteger(sequence) || sequence !== last + 1
          || (frame === undefined && cursor === undefined && position === undefined)) throw new Error('Invalid KMS bitmap frame');
      // Validate the whole bundle before consuming either plane.
      if (frame !== undefined && (!(frame instanceof ImageBitmap) || frame.width < 1 || frame.width > 3840
          || frame.height < 1 || frame.height > 2160)) throw new Error('Invalid KMS bitmap extent');
      if (cursor !== undefined) {
        if (!plane || !cursor) throw new Error('Invalid KMS cursor update');
        validateCursor(cursor);
      }
      if (position !== undefined && (!position || frame !== undefined || cursor !== undefined
          || !lastCursor || lastCursor.composited || lastCursor.cursor.pixels === null
          || !Number.isSafeInteger(position.version) || position.version <= lastCursor.cursor.version
          || !Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y))) {
        throw new Error('Invalid KMS cursor position');
      }
      if (frame) {
        if (canvas.width !== frame.width) canvas.width = frame.width;
        if (canvas.height !== frame.height) canvas.height = frame.height;
        context.transferFromImageBitmap(frame);
      }
      if (cursor) {
        lastCursor = cursor;
        restoreCursor();
      } else if (position && lastCursor) {
        const { version, x, y } = position;
        lastCursor = { ...lastCursor, cursor: { ...lastCursor.cursor, version, x, y } };
        restoreCursor();
      }
      last = sequence;
      port.postMessage({ type: 'ack', sequence });
    } finally {
      // Native transfer consumes an image. Closing a consumed image is harmless.
      if (frame instanceof ImageBitmap) frame.close();
    }
  };
  port.onmessageerror = () => { throw new Error('Invalid KMS bitmap display message'); };
  port.start();
  // [RUNTIME-WORKAROUND: FIREFOX-BITMAP-PORT-STARTUP] The producer waits
  // until the native contexts and the receiving port are initialized.
  port.postMessage({ type: 'ready' });
}
