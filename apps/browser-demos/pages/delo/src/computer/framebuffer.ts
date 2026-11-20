// The framebuffer of a delo computer: /dev/fb0 painted on a canvas, focused
// keys sent to the bound process as Linux MEDIUMRAW bytes, and a click that
// locks the mouse for /dev/input/mice.

import { attachLinuxMediumRawKeyboard, attachPointerLockMouse, injectChunkedMouseMotion, linuxKeyCodeFromKeyboardEvent } from "../../../../../../host/src/framebuffer/browser-controls";
import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";
import { pressKeys } from "./keys";
import type { OpenSurface } from "./surface";

export interface OpenFramebuffer extends OpenSurface {
  /** The canvas at /dev/fb0's resolution, or null while no process draws on it. */
  screen(): HTMLCanvasElement | null;
  /** Whether the bound process reads the key with DOM `code`. */
  knows(code: string): boolean;
  /** Press keys as the user's keys do; false while no process draws on /dev/fb0. */
  press(codes: readonly string[], holdMs: number): Promise<boolean>;
  /** Move the mouse `dx` pixels right and `dy` down with PS/2 `buttons` held; false while no process draws on /dev/fb0. */
  move(dx: number, dy: number, buttons: number): boolean;
}

export function openFramebuffer(host: KernelHost, canvas: HTMLCanvasElement): OpenFramebuffer {
  const handle = host.attachFramebuffer(canvas);
  const bound = () => handle.getBoundPid() !== null;
  attachLinuxMediumRawKeyboard(canvas, { sendInput: (bytes) => handle.sendInput(bytes) }, { getEnabled: bound, releaseDelayMs: 16 });
  attachPointerLockMouse(canvas, { injectMouseEvent: (dx, dy, buttons) => handle.sendMouseEvent(dx, dy, buttons) }, { getEnabled: bound });
  return {
    focus: () => canvas.focus(),
    screen: () => bound() ? canvas : null,
    knows: (code) => linuxKeyCodeFromKeyboardEvent({ code, key: "Unidentified" }) !== null,
    press: async (codes, holdMs) => {
      if (!bound()) return false;
      await pressKeys(canvas, codes, holdMs);
      return true;
    },
    move: (dx, dy, buttons) => {
      if (!bound()) return false;
      if (dx === 0 && dy === 0) handle.sendMouseEvent(0, 0, buttons);
      else injectChunkedMouseMotion({ injectMouseEvent: (x, y, mask) => handle.sendMouseEvent(x, y, mask) }, dx, -dy, buttons);
      return true;
    },
  };
}
