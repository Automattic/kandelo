/**
 * Tab-to-tab machine handover demo (T2.4).
 *
 * Tab 1 boots a machine, runs fbDOOM on /dev/fb0, and offers its machine on
 * the local handover channel. Tab 2 asks, receives the frozen checkpoint over
 * BroadcastChannel, and boots a receiver machine from it; tab 1 stops. The
 * game continues from the captured frame, keyboard included. Audio stays
 * disabled: this page wires no PCM consumer, and a working /dev/dsp would
 * park fbDOOM in a write nobody drains.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { attachCanvas, attachLinuxMediumRawKeyboard } from "@host/framebuffer";
import type { MachineCheckpoint } from "@host/migration/checkpoint";
import { LocalCheckpointHandover } from "@host/migration/transport-local";
import kernelWasmUrl from "@kernel-wasm?url";
import fbdoomUrl from "@binaries/programs/wasm32/fbdoom.wasm?url";
import {
  createBuildFsWithEtc,
  finalizeKernelOwnedImage,
  settleWebKitReclaim,
} from "../../lib/kernel-owned-boot";

/** Same pinned shareware IWAD as `host/test/support/doom-shareware.ts`. */
const DOOM_WAD_URL =
  "https://cdn.jsdelivr.net/gh/gaborbata/vanilla-mocha-doom@15825a07a48806bcfb242a42afd5ee7cb3c9a3a4/wads/doom1.wad";
const CAPTURE_TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };

declare global {
  interface Window {
    __migrationDemo: {
      state: () => string;
      framePixelSum: () => number;
    };
  }
}

const statusLine = document.getElementById("status") as HTMLDivElement;
const startButton = document.getElementById("start") as HTMLButtonElement;
const takeButton = document.getElementById("take") as HTMLButtonElement;
const canvas = document.getElementById("screen") as HTMLCanvasElement;

let kernel: BrowserKernel | null = null;
let pid = 0;
let detachCanvas: (() => void) | null = null;
let detachKeyboard: (() => void) | null = null;
let stopOffer: (() => void) | null = null;
const handover = new LocalCheckpointHandover();

function setStatus(text: string): void {
  statusLine.textContent = text;
}

async function fetchBytes(url: string, what: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${what} fetch failed: ${response.status}`);
  }
  return response.arrayBuffer();
}

function attachScreen(machine: BrowserKernel, screenPid: number): void {
  detachCanvas?.();
  detachKeyboard?.();
  detachCanvas = attachCanvas(canvas, machine.framebuffers, screenPid, {
    getProcessMemory: (candidate) => machine.getProcessMemory(candidate),
  });
  const keyboard = attachLinuxMediumRawKeyboard(
    canvas,
    { sendInput: (bytes) => machine.ptyWrite(screenPid, bytes) },
    { getEnabled: () => kernel === machine },
  );
  detachKeyboard = () => keyboard.close();
}

function offerThisMachine(): void {
  stopOffer?.();
  stopOffer = handover.offer(
    async () => {
      if (!kernel) return null;
      const capture = await kernel.captureCheckpointBytes(CAPTURE_TIMEOUTS);
      if (capture.status !== "captured") {
        throw new Error(`capture ${capture.status}: ${"reason" in capture ? capture.reason : ""}`);
      }
      return capture.checkpoint;
    },
    () => {
      // The machine now lives in the taking tab. Truthfully stop this one
      // rather than keep a second divergent copy running.
      const handedOver = kernel;
      kernel = null;
      stopOffer?.();
      stopOffer = null;
      detachCanvas?.();
      detachCanvas = null;
      detachKeyboard?.();
      detachKeyboard = null;
      setStatus("Handed over — the machine continues in the other tab.");
      void handedOver?.destroy().then(() => settleWebKitReclaim());
    },
  );
}

async function start(): Promise<void> {
  startButton.disabled = true;
  takeButton.disabled = true;
  try {
    setStatus("Fetching fbDOOM and the shareware IWAD...");
    const [kernelWasm, fbdoom, wad] = await Promise.all([
      fetchBytes(kernelWasmUrl as string, "kernel"),
      fetchBytes(fbdoomUrl as string, "fbdoom"),
      fetchBytes(DOOM_WAD_URL, "doom1.wad"),
    ]);
    setStatus("Booting the machine...");
    const buildFs = await createBuildFsWithEtc();
    const wadBytes = new Uint8Array(wad);
    const fd = buildFs.open("/doom1.wad", 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o644);
    buildFs.write(fd, wadBytes, null, wadBytes.length);
    buildFs.close(fd);
    const image = await finalizeKernelOwnedImage(buildFs);
    const machine = new BrowserKernel({ kernelOwnedFs: true });
    await machine.initFromOwnedImage({
      kernelWasm,
      vfsImage: (image.byteOffset === 0
        && image.byteLength === image.buffer.byteLength
        ? image.buffer
        : image.slice().buffer) as ArrayBuffer,
    });
    kernel = machine;
    await new Promise<void>((resolve) => {
      void machine.spawn(fbdoom, ["fbdoom", "-iwad", "/doom1.wad"], {
        pty: true,
        env: ["AUDIODEV=/nonexistent-dsp"],
        onStarted: (startedPid) => {
          pid = startedPid;
          resolve();
        },
      });
    });
    attachScreen(machine, pid);
    offerThisMachine();
    setStatus("Running. Open this page in a second tab and take over there.");
  } catch (error) {
    setStatus(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
    startButton.disabled = false;
  }
}

async function take(): Promise<void> {
  startButton.disabled = true;
  takeButton.disabled = true;
  try {
    setStatus("Asking the other tab for its machine...");
    const checkpoint: MachineCheckpoint = await handover.take(30_000);
    if (checkpoint.processes.length === 0) {
      throw new Error("the checkpoint carries no process");
    }
    setStatus("Received the checkpoint; booting the receiver...");
    const kernelWasm = await fetchBytes(kernelWasmUrl as string, "kernel");
    const buildFs = await createBuildFsWithEtc();
    const image = await finalizeKernelOwnedImage(buildFs);
    const machine = new BrowserKernel({ kernelOwnedFs: true });
    await machine.initFromOwnedImage({
      kernelWasm,
      vfsImage: (image.byteOffset === 0
        && image.byteLength === image.buffer.byteLength
        ? image.buffer
        : image.slice().buffer) as ArrayBuffer,
      restoreCheckpoint: checkpoint,
    });
    kernel = machine;
    pid = checkpoint.processes[0]!.pid;
    attachScreen(machine, pid);
    offerThisMachine();
    setStatus("Running the restored machine — taken over from the other tab.");
  } catch (error) {
    setStatus(`Take over failed: ${error instanceof Error ? error.message : String(error)}`);
    startButton.disabled = false;
    takeButton.disabled = false;
  }
}

startButton.addEventListener("click", () => void start());
takeButton.addEventListener("click", () => void take());

window.__migrationDemo = {
  state: () => statusLine.textContent ?? "",
  framePixelSum: () => {
    if (!kernel) return -1;
    const binding = kernel.framebuffers.get(pid);
    if (!binding?.hostBuffer) return -1;
    let sum = 0;
    // Sampling every 97th byte keeps the probe cheap while any animation
    // still changes it.
    for (let i = 0; i < binding.hostBuffer.length; i += 97) {
      sum += binding.hostBuffer[i]!;
    }
    return sum;
  },
};
