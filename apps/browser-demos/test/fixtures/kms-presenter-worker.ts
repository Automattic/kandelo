// Fixture worker for kandelo-kms-presenter.spec.ts. Drives the shipped
// KMS presenter path — attachKmsCanvas + the GL claim/release callbacks +
// the vblank pump — against a real worker-side WebGL2 context, so the
// spec can read the result off the composited page. The vitest fake-GL
// suite records the calls the presenter makes; only a real context shows
// whether the uploads it makes are accepted.
import { CentralizedKernelWorker } from "@host/kernel-worker";
import type { PlatformIO } from "@host/types";

const FB = 64;

/** XRGB8888 little-endian scanout bytes: [B,G,R,X], X = 0. The presenter's
 *  fragment shader samples .bgr and forces alpha opaque. */
function scanout(top: [number, number, number], bottom: [number, number, number]): Uint8Array {
  const px = new Uint8Array(FB * FB * 4);
  for (let y = 0; y < FB; y++) {
    const [r, g, b] = y < FB / 2 ? top : bottom;
    for (let x = 0; x < FB; x++) {
      const o = (y * FB + x) * 4;
      px[o] = b;
      px[o + 1] = g;
      px[o + 2] = r;
      px[o + 3] = 0;
    }
  }
  return px;
}

type Kms = { currentFb: (id: number) => unknown; scanoutBytes: (id: number) => Uint8Array };

let kernel: CentralizedKernelWorker;
let canvas: OffscreenCanvas;
let pixels = scanout([255, 0, 0], [0, 255, 0]);
let commits = 1;

const tick = () => (kernel as unknown as { tickVblank: () => void }).tickVblank();
const callbacks = () => (kernel as unknown as {
  kernel: { callbacks: Record<string, (crtc: number) => void> };
}).kernel.callbacks;

function init(offscreen: OffscreenCanvas) {
  canvas = offscreen;
  kernel = new CentralizedKernelWorker(
    { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true },
    {} as PlatformIO,
  );
  const fb = { fb_id: 10, bo_id: 100, width: FB, height: FB, pixel_format: 0, pitch: FB * 4 };
  const kms = kernel.kms as unknown as Kms;
  kms.currentFb = () => fb;
  kms.scanoutBytes = () => pixels;
  (kernel as unknown as { kernelInstance: unknown }).kernelInstance = {
    exports: {
      kernel_kms_commit_count: () => BigInt(commits),
      kernel_kms_last_frame_us: () => 0n,
    },
  };
  const stats = new SharedArrayBuffer(8 * 4);
  kernel.attachKmsCanvas(1, canvas, stats, { mode: "webgl2-scanout" });
  kernel.setKmsDisplaySize(1, FB, FB);
  tick();
  return { presenter: Atomics.load(new Int32Array(stats), 7) };
}

/** Everything a program GL session can leave behind that the scanout
 *  upload depends on. Each is reachable from the guest: OP_PIXEL_STOREI
 *  forwards any pname and OP_BIND_BUFFER accepts any target. */
function pollute() {
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
  callbacks().markKmsCanvasGlOwned(1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 8);
  gl.pixelStorei(gl.UNPACK_ROW_LENGTH, FB * 2);
  gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 4);
  gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 4);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, gl.createBuffer());
  gl.bufferData(gl.PIXEL_UNPACK_BUFFER, 16, gl.STREAM_DRAW);
  return { polluted: true };
}

/** The EGL teardown: the pump resumes and rebuilds a presenter on the
 *  context the dead session was driving. */
function release() {
  callbacks().markKmsCanvasGlReleased(1);
  pixels = scanout([0, 0, 255], [255, 255, 0]);
  commits++;
  tick();
  return { released: true };
}

self.onmessage = (e: MessageEvent) => {
  const { step } = e.data as { step: string; canvas?: OffscreenCanvas };
  try {
    if (step === "init") self.postMessage({ step, ...init(e.data.canvas) });
    else if (step === "pollute") self.postMessage({ step, ...pollute() });
    else if (step === "release") self.postMessage({ step, ...release() });
  } catch (err) {
    self.postMessage({ step, error: String(err) });
  }
};
