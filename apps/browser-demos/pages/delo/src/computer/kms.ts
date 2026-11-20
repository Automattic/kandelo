// The KMS display of a delo computer: the host's scanout canvas for the first
// CRTC with its cursor plane, and the pointer sent to both mouse devices:
// absolute positions to /dev/input/event1, deltas to /dev/input/mice. The
// keys reach the machine's evdev keyboard through the input source the boot
// attaches, which captures them over the canvas marked
// `data-kandelo-display="kms"`.

import { injectChunkedMouseMotion } from "../../../../../../host/src/framebuffer/browser-controls";
import { codeToKey } from "../../../../../../host/src/input/key-code-table";
import { pointerButtons } from "../../../../../../host/src/input/pointer-buttons";
import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import { pressKeys } from "./keys";
import type { OpenSurface } from "./surface";

const SIZE = { width: 1920, height: 1080 };

export interface OpenKms extends OpenSurface {
  /** The scanout's size in pixels, or null while nothing is shown. */
  scanout(): { width: number; height: number } | null;
  /** The canvas the scanout is painted on. */
  screen(): HTMLCanvasElement;
  /** Whether the evdev keyboard has a key for DOM `code`. */
  knows(code: string): boolean;
  /** Press keys as the user's keys do. */
  press(codes: readonly string[], holdMs: number): Promise<void>;
  /** Move the pointer to scanout pixel (x, y) with PS/2 `buttons` held. */
  point(x: number, y: number, buttons: number): void;
}

export function openKms(host: KernelHost, container: HTMLElement): OpenKms {
  const canvas = host.kmsDisplayCanvas(undefined, SIZE);
  canvas.tabIndex = 0;
  canvas.classList.add("delo-kms-canvas");
  canvas.dataset.kandeloDisplay = "kms";
  const cursor = host.kmsCursorCanvas();
  cursor.classList.add("delo-kms-cursor");
  cursor.setAttribute("aria-hidden", "true");
  container.replaceChildren(canvas, cursor);
  const handle = host.attachKmsDisplay(canvas);
  if (handle === null) throw new Error("this kernel cannot show a KMS display");

  const scanout = () => {
    const width = Atomics.load(handle.stats, 2);
    const height = Atomics.load(handle.stats, 3);
    return width > 0 && height > 0 ? { width, height } : null;
  };
  let buttons = 0;
  let last: { x: number; y: number } | null = null;
  const point = (x: number, y: number, held: number) => {
    if (last !== null) {
      injectChunkedMouseMotion({ injectMouseEvent: (dx, dy, mask) => handle.sendMouseEvent(dx, dy, mask) }, x - last.x, last.y - y, held);
    }
    last = { x, y };
    handle.sendPointerAbs(x, y, held);
  };
  const at = (event: PointerEvent) => {
    const size = scanout();
    const rect = canvas.getBoundingClientRect();
    if (size === null || rect.width <= 0 || rect.height <= 0) return null;
    const scale = Math.min(rect.width / size.width, rect.height / size.height);
    const left = rect.left + (rect.width - size.width * scale) / 2;
    const top = rect.top + (rect.height - size.height * scale) / 2;
    const clamp = (value: number, max: number) => Math.min(Math.max(Math.round(value), 0), max - 1);
    return { x: clamp((event.clientX - left) / scale, size.width), y: clamp((event.clientY - top) / scale, size.height) };
  };
  const pointer = (phase: "down" | "move" | "up") => (event: PointerEvent) => {
    const position = at(event);
    if (position === null) return;
    buttons = pointerButtons(buttons, event, phase, true);
    point(position.x, position.y, buttons);
    if (phase === "down") canvas.setPointerCapture(event.pointerId);
  };
  canvas.addEventListener("pointerdown", pointer("down"));
  canvas.addEventListener("pointermove", pointer("move"));
  canvas.addEventListener("pointerup", pointer("up"));
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  return {
    focus: () => canvas.focus(),
    scanout,
    screen: () => canvas,
    knows: (code) => codeToKey(code) !== null,
    press: (codes, holdMs) => {
      canvas.focus();
      if (document.activeElement !== canvas && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      return pressKeys(canvas, codes, holdMs);
    },
    point,
  };
}
