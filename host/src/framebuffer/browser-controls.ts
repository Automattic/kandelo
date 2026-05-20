/**
 * Browser-side input/audio helpers for framebuffer demos.
 *
 * Rendering stays in `canvas-renderer.ts`; this module covers the two
 * browser-only device bridges used by fbDOOM:
 *
 *   - Pointer Lock mouse deltas -> `/dev/input/mice` PS/2 packets.
 *   - `/dev/dsp` PCM ring drains -> Web Audio playback.
 */

export interface MouseEventSink {
  /**
   * Deltas are in PS/2 convention: positive X is right, positive Y is up.
   * `buttons` uses PS/2 bits: bit0=left, bit1=right, bit2=middle.
   */
  injectMouseEvent(dx: number, dy: number, buttons: number): void;
}

export interface PointerLockMouseOptions {
  /**
   * Browser `movementX/Y` are CSS pixels, but `/dev/input/mice` consumers
   * expect mouse mickeys. The default is calibrated for fbDOOM's default
   * sensitivity: around four mickeys per framebuffer pixel makes local
   * pointer-lock motion track the screen-space motion a visible cursor would
   * have across a 90-degree Doom view.
   */
  sensitivity?: number;
  /** Convert CSS-pixel deltas into framebuffer-pixel deltas first. */
  scaleToCanvasPixels?: boolean;
  /** Automatically request pointer lock from a canvas click. */
  requestPointerLockOnClick?: boolean;
  /** Return false to suppress capture/motion while no fb client is bound. */
  getEnabled?: () => boolean;
  onCaptureChange?: (captured: boolean) => void;
}

export interface PointerLockMouseHandle {
  requestCapture(): void;
  releaseCapture(): void;
  releaseButtons(): void;
  isCaptured(): boolean;
  close(): void;
}

export interface ScalePointerLockMouseDeltaOptions {
  sensitivity?: number;
  scaleToCanvasPixels?: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
  clientWidth?: number;
  clientHeight?: number;
}

export interface AudioDrainSource {
  drainAudio(maxBytes: number): Promise<{
    bytes: Uint8Array;
    sampleRate: number;
    channels: number;
  }>;
}

export interface PcmAudioSchedulerOptions {
  pollMs?: number;
  drainBytes?: number;
  lookaheadSeconds?: number;
  maxLookaheadSeconds?: number;
}

export interface AudioOutputHandle {
  resume(): Promise<void>;
  close(): void;
  getState(): AudioContextState | "unavailable";
}

export const DEFAULT_POINTER_LOCK_MOUSE_SENSITIVITY = 4;

const AUDIO_POLL_MS = 50;
const AUDIO_DRAIN_BYTES = 32 * 1024;
const MIN_MOUSE_DELTA = -128;
const MAX_MOUSE_DELTA = 127;

export function scalePointerLockMouseDelta(
  movementX: number,
  movementY: number,
  opts: ScalePointerLockMouseDeltaOptions = {},
): { dx: number; dy: number } {
  const sensitivity = opts.sensitivity ?? DEFAULT_POINTER_LOCK_MOUSE_SENSITIVITY;
  const scaleToCanvasPixels = opts.scaleToCanvasPixels ?? true;
  const scaleX = scaleToCanvasPixels && opts.canvasWidth && opts.clientWidth
    ? opts.canvasWidth / opts.clientWidth
    : 1;
  const scaleY = scaleToCanvasPixels && opts.canvasHeight && opts.clientHeight
    ? opts.canvasHeight / opts.clientHeight
    : 1;

  return {
    dx: movementX * scaleX * sensitivity,
    // Browser coordinates are positive-down; PS/2 is positive-up.
    dy: -movementY * scaleY * sensitivity,
  };
}

export function injectChunkedMouseMotion(
  sink: MouseEventSink,
  dx: number,
  dy: number,
  buttons: number,
): void {
  let remainingX = finiteTrunc(dx);
  let remainingY = finiteTrunc(dy);

  while (remainingX !== 0 || remainingY !== 0) {
    const stepX = clamp(remainingX, MIN_MOUSE_DELTA, MAX_MOUSE_DELTA);
    const stepY = clamp(remainingY, MIN_MOUSE_DELTA, MAX_MOUSE_DELTA);
    sink.injectMouseEvent(stepX, stepY, buttons & 0x07);
    remainingX -= stepX;
    remainingY -= stepY;
  }
}

export function attachPointerLockMouse(
  canvas: HTMLCanvasElement,
  sink: MouseEventSink,
  opts: PointerLockMouseOptions = {},
): PointerLockMouseHandle {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  const requestPointerLockOnClick = opts.requestPointerLockOnClick ?? true;
  const getEnabled = opts.getEnabled ?? (() => true);
  let closed = false;
  let buttons = 0;
  let fractionalX = 0;
  let fractionalY = 0;

  const buttonBit = (button: number) =>
    button === 0 ? 1 : button === 2 ? 2 : button === 1 ? 4 : 0;

  const captured = () => doc.pointerLockElement === canvas;

  const notifyCapture = () => {
    opts.onCaptureChange?.(captured());
  };

  const requestCapture = () => {
    if (closed || !getEnabled()) return;
    canvas.focus();
    if (!captured()) {
      canvas.requestPointerLock();
    }
  };

  const releaseButtons = () => {
    if (buttons === 0) return;
    buttons = 0;
    sink.injectMouseEvent(0, 0, 0);
  };

  const releaseCapture = () => {
    releaseButtons();
    if (captured()) {
      doc.exitPointerLock();
    }
  };

  const onClick = () => {
    if (requestPointerLockOnClick) requestCapture();
  };

  const onMouseMove = (e: MouseEvent) => {
    if (!captured() || !getEnabled()) return;
    const rect = canvas.getBoundingClientRect();
    const scaled = scalePointerLockMouseDelta(e.movementX, e.movementY, {
      sensitivity: opts.sensitivity,
      scaleToCanvasPixels: opts.scaleToCanvasPixels,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      clientWidth: rect.width,
      clientHeight: rect.height,
    });

    fractionalX += scaled.dx;
    fractionalY += scaled.dy;
    const dx = finiteTrunc(fractionalX);
    const dy = finiteTrunc(fractionalY);
    fractionalX -= dx;
    fractionalY -= dy;
    if (dx === 0 && dy === 0) return;
    injectChunkedMouseMotion(sink, dx, dy, buttons);
  };

  const onMouseDown = (e: MouseEvent) => {
    if (!captured() || !getEnabled()) return;
    const bit = buttonBit(e.button);
    if (bit === 0) return;
    e.preventDefault();
    buttons |= bit;
    sink.injectMouseEvent(0, 0, buttons);
  };

  const onMouseUp = (e: MouseEvent) => {
    if (!captured() && buttons === 0) return;
    const bit = buttonBit(e.button);
    if (bit === 0) return;
    e.preventDefault();
    buttons &= ~bit;
    sink.injectMouseEvent(0, 0, buttons);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  const onPointerLockChange = () => {
    if (!captured()) {
      releaseButtons();
      fractionalX = 0;
      fractionalY = 0;
    }
    notifyCapture();
  };

  const onWindowBlur = () => {
    releaseCapture();
  };

  canvas.addEventListener("click", onClick);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("contextmenu", onContextMenu);
  doc.addEventListener("mouseup", onMouseUp);
  doc.addEventListener("pointerlockchange", onPointerLockChange);
  win?.addEventListener("blur", onWindowBlur);
  notifyCapture();

  return {
    requestCapture,
    releaseCapture,
    releaseButtons,
    isCaptured: captured,
    close: () => {
      if (closed) return;
      closed = true;
      releaseCapture();
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("contextmenu", onContextMenu);
      doc.removeEventListener("mouseup", onMouseUp);
      doc.removeEventListener("pointerlockchange", onPointerLockChange);
      win?.removeEventListener("blur", onWindowBlur);
      opts.onCaptureChange?.(false);
    },
  };
}

export function createPcmAudioScheduler(
  source: AudioDrainSource,
  opts: PcmAudioSchedulerOptions = {},
): AudioOutputHandle {
  const AudioContextCtor =
    globalThis.AudioContext ??
    (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return {
      resume: async () => {},
      close: () => {},
      getState: () => "unavailable",
    };
  }

  const audioCtx = new AudioContextCtor();
  const pollMs = opts.pollMs ?? AUDIO_POLL_MS;
  const drainBytes = opts.drainBytes ?? AUDIO_DRAIN_BYTES;
  const lookaheadSeconds = opts.lookaheadSeconds ?? 0.04;
  const maxLookaheadSeconds = opts.maxLookaheadSeconds ?? 0.15;

  let cursor = audioCtx.currentTime;
  let sampleRate = 44100;
  let channels = 2;
  let stopped = false;

  const timer = globalThis.setInterval(async () => {
    if (stopped || audioCtx.state !== "running") return;

    let drain;
    try {
      drain = await source.drainAudio(drainBytes);
    } catch {
      return;
    }

    const bytes = drain.bytes;
    if (bytes.byteLength === 0) return;
    if (drain.sampleRate > 0) sampleRate = drain.sampleRate;
    if (drain.channels > 0) channels = drain.channels;

    const bytesPerFrame = 2 * channels;
    const frames = Math.floor(bytes.byteLength / bytesPerFrame);
    if (frames === 0) return;

    const buffer = audioCtx.createBuffer(channels, frames, sampleRate);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let ch = 0; ch < channels; ch++) {
      const dst = buffer.getChannelData(ch);
      for (let i = 0; i < frames; i++) {
        const sample = view.getInt16((i * channels + ch) * 2, true);
        dst[i] = sample / 32768;
      }
    }

    const now = audioCtx.currentTime;
    if (cursor < now + lookaheadSeconds) {
      cursor = now + lookaheadSeconds;
    } else if (cursor > now + maxLookaheadSeconds) {
      cursor = now + lookaheadSeconds;
      return;
    }

    const node = audioCtx.createBufferSource();
    node.buffer = buffer;
    node.connect(audioCtx.destination);
    node.start(cursor);
    cursor += frames / sampleRate;
  }, pollMs);

  return {
    resume: async () => {
      if (audioCtx.state === "suspended") {
        await audioCtx.resume().catch(() => {});
      }
    },
    close: () => {
      if (stopped) return;
      stopped = true;
      globalThis.clearInterval(timer);
      void audioCtx.close().catch(() => {});
    },
    getState: () => audioCtx.state,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteTrunc(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}
