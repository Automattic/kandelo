/**
 * PR7 Phase-3 gate: wlterm — a real terminal emulator built on the full
 * PR7 stack. A libkwl window (Phase 2) hosts an in-tree VT100 core
 * (programs/wlterm/vt100.c) that renders with libwpkdraw (Phase 1), and a
 * forkpty()'d shell drives the grid. This is the end-to-end wayland demo:
 * cage (the wlroots kiosk compositor) + toolkit client + terminal + child
 * process, all under one NodeKernelHost, talking over the AF_UNIX socket
 * at /tmp/wayland-0.
 *
 * The flow, and what each step proves:
 *
 *   - wlterm maps its toplevel via libkwl and commits a first frame, then
 *     prints WLTERM_READY — the compositor imported + presented it;
 *   - wlterm forkpty()'s a bash `-c` script — bash because it is the shell
 *     every Kandelo image binds to /bin/sh, so the smoke drives the same
 *     shell the Wayland desktop's wlterm runs — that prints "READY", reads
 *     a line, then echoes it back as "GOT[<x>]";
 *   - the shell's "READY" reaches the PTY master → vt100_feed() → the cell grid,
 *     and wlterm's --watch reports WLTERM_GRID "READY" once it is visible;
 *   - a host-injected key A + Return is routed cage → libkwl (KWL_KEY)
 *     → vt100_input_key() → write(master), so the shell's `read x` returns "a"
 *     (Return → "\r", the tty's ICRNL makes it the newline) and prints
 *     "GOT[a]" → WLTERM_GRID "GOT[a]";
 *   - the shell exits, the PTY master hangs up, wlterm reaps it and prints
 *     WLTERM_EXIT code=0.
 *
 * The same input path runs under sway's configured WAYLAND_DISPLAY.
 * wlterm exits 0; cage forwards its status and sway is stopped through IPC.
 * Normal compositor and shell artifacts are required, never skipped.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { WLROOTS_ENV, compositorBytes, requireSession, sessionRootfs } from "./wlroots-session";

const wltermBin = resolveBinary("programs/wayland-demo/wlterm.wasm");
const shellBin = resolveBinary("programs/bash.wasm");
requireSession("cage");
requireSession("sway");
const dashBin = resolveBinary("programs/dash.wasm");
const swaymsgBin = resolveBinary("programs/sway/swaymsg.wasm");

// Input canvas dims are arbitrary here — wlterm is keyboard-driven, and the
// compositor routes keys by keycode independent of the pointer scale. We match
// the card0 output anyway for consistency with the other smokes.
const CANVAS_W = 1920;
const CANVAS_H = 1080;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_A = 30;
const KEY_ENTER = 28;

// signal.h
const SIGKILL = 9;

function wltermRootfs(compositor: "cage" | "sway" = "cage"): Promise<Uint8Array> {
  return sessionRootfs(compositor, [
    { path: "/usr/bin/wlterm", bytes: new Uint8Array(readFileSync(wltermBin!)), mode: 0o755 },
    { path: "/bin/bash", bytes: new Uint8Array(readFileSync(shellBin!)), mode: 0o755 },
    { path: "/bin/sh", bytes: new Uint8Array(readFileSync(dashBin)), mode: 0o755 },
    { path: "/usr/bin/swaymsg", bytes: new Uint8Array(readFileSync(swaymsgBin)), mode: 0o755 },
    { path: "/usr/share/fonts/Inconsolata-Regular.ttf", bytes: new Uint8Array(
      readFileSync(new URL("../../third_party/Inconsolata-Regular.ttf", import.meta.url))), mode: 0o644 },
    { path: "/etc/fonts/fonts.conf", bytes: new TextEncoder().encode(
      '<fontconfig><dir>/usr/share/fonts</dir><cachedir>/tmp/fontconfig</cachedir></fontconfig>'), mode: 0o644 },
    { path: "/etc/sway/config", bytes: new TextEncoder().encode(
      "exec /usr/bin/wlterm --watch READY --watch 'GOT[a]' /bin/bash /usr/bin/session\n"), mode: 0o644 },
    { path: "/usr/bin/session", bytes: new TextEncoder().encode(
      "printf 'READY\\n'; read x; printf 'GOT[%s]\\n' \"$x\"\n"), mode: 0o755 },
  ]);
}

async function waitFor(
  ref: { value: string },
  needle: string,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (ref.value.includes(needle)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(needle)}.\n${context()}`);
}

describe("wlterm — libkwl terminal renders shell output and routes typed input", () => {
  it.each(["cage", "sway"] as const)(
    "%s: shell output reaches the grid; a typed line round-trips back through it",
    async (compositor) => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        rootfsImage: await wltermRootfs(compositor),
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });

      const dump = () =>
        `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const env = [...WLROOTS_ENV, "PATH=/usr/bin:/bin", "HOME=/root",
          "TERM=vt100", "SWAYSOCK=/tmp/sway-ipc.sock"];
        const args = compositor === "cage" ? ["cage", "--",
          "/usr/bin/wlterm", "--watch", "READY", "--watch", "GOT[a]",
          "/bin/bash", "/usr/bin/session"] : ["sway"];
        const compositorExit = host.spawn(compositorBytes(compositor), args, { env });

        // The window mapped and committed its first frame.
        await waitFor(out, "WLTERM_READY", 20_000, dump);
        // The shell's "READY" flowed PTY → vt100_feed → grid.
        await waitFor(out, 'WLTERM_GRID "READY"', 20_000, dump);

        // Type "a" then Return on the keyboard (device 0). cage routes each
        // to the focused wlterm surface; libkwl compiles the
        // keycode to a keysym; vt100 maps it to bytes written to the PTY.
        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_A, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_ENTER, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_ENTER, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);

        // The shell's `read x` got "a" and echoed GOT[a] back into the grid.
        await waitFor(out, 'WLTERM_GRID "GOT[a]"', 20_000, dump);

        // The shell exits → PTY HUP → wlterm reaps it and shuts down cleanly.
        await waitFor(out, "WLTERM_EXIT code=0", 20_000, dump);

        // sway stays alive after its configured terminal exits.
        if (compositor === "sway") {
          const control = readFileSync(swaymsgBin);
          await host.spawn(control.buffer.slice(control.byteOffset,
            control.byteOffset + control.byteLength), ["swaymsg", "exit"], { env });
        }
        const compositorCode = await Promise.race([
          compositorExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`cage timed out.\n${dump()}`)), 25_000)),
        ]);
        expect(compositorCode, `${compositor} exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );

  it(
    "a shell killed by a signal is reported as a signal death, not a clean exit",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        rootfsImage: await wltermRootfs(),
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });

      const dump = () =>
        `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        // WEXITSTATUS is undefined for a signal death, so the status must not
        // reach the grid as a code=.
        const cageExit = host.spawn(
          compositorBytes("cage"),
          ["cage", "--", "/usr/bin/wlterm", "/bin/bash", "-c", `kill -${SIGKILL} $$`],
          { env: [...WLROOTS_ENV, "PATH=/usr/bin:/bin", "HOME=/root", "TERM=vt100"] },
        );

        await waitFor(out, "WLTERM_READY", 20_000, dump);
        await waitFor(out, `WLTERM_EXIT signal=${SIGKILL}`, 20_000, dump);
        expect(out.value, `signal death reported as an exit code.\n${dump()}`)
          .not.toContain("WLTERM_EXIT code=");

        const cageCode = await Promise.race([
          cageExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`cage timed out.\n${dump()}`)), 25_000)),
        ]);
        expect(cageCode, `cage exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
