/**
 * PR7 Phase-3 gate: wlterm — a real terminal emulator built on the full
 * PR7 stack. A libkwl window (Phase 2) hosts an in-tree VT100 core
 * (programs/wlterm/vt100.c) that renders with libwpkdraw (Phase 1), and a
 * forkpty()'d shell drives the grid. This is the end-to-end wayland demo:
 * compositor server + toolkit client + terminal + child process, all under
 * one NodeKernelHost, talking over the AF_UNIX socket at /tmp/wayland-0.
 *
 * The flow, and what each step proves:
 *
 *   - wlterm maps its toplevel via libkwl and commits a first frame, then
 *     prints WLTERM_READY — the compositor imported + presented it;
 *   - wlterm forkpty()'s a dash `-c` script (mapped through onResolveExec)
 *     that prints "READY", reads a line, then echoes it back as "GOT[<x>]";
 *   - dash's "READY" reaches the PTY master → vt100_feed() → the cell grid,
 *     and wlterm's --watch reports WLTERM_GRID "READY" once it is visible;
 *   - a host-injected key A + Return is routed compositor → libkwl (KWL_KEY)
 *     → vt100_input_key() → write(master), so dash's `read x` returns "a"
 *     (Return → "\r", the tty's ICRNL makes it the newline) and prints
 *     "GOT[a]" → WLTERM_GRID "GOT[a]";
 *   - dash exits, the PTY master hangs up, wlterm reaps it and prints
 *     WLTERM_EXIT code=0.
 *
 * wlterm and the compositor both exit 0. Skips if any binary is missing
 * (bare checkout — dash comes from the package cache / binaries tree).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const compositorBin = tryResolveBinary("programs/wlcompositor.wasm");
const wltermBin = tryResolveBinary("programs/wlterm.wasm");
const dashBin = tryResolveBinary("programs/dash.wasm");
const hasBinaries = !!compositorBin && !!wltermBin && !!dashBin && existsSync(dashBin!);

// Input canvas dims are arbitrary here — wlterm is keyboard-driven, and the
// compositor routes keys by keycode independent of the pointer scale. We match
// the compositor's card0 output anyway for consistency with the other smokes.
const CANVAS_W = 1920;
const CANVAS_H = 1080;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_A = 30;
const KEY_ENTER = 28;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
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
  it.skipIf(!hasBinaries)(
    "shell output reaches the grid; a typed line round-trips back through it",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const wltermBytes = loadBytes(wltermBin!);
      const dashBytes = loadBytes(dashBin!);

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
        // The forkpty'd child execvp("dash")s. musl walks PATH, so the kernel
        // asks us to resolve /usr/bin/dash, /bin/dash, … — match any /dash.
        onResolveExec: (path) =>
          path === "dash" || path.endsWith("/dash") ? dashBytes : null,
      });

      const dump = () =>
        `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        // --- compositor (server) ---
        const compExit = host.spawn(compositorBytes, ["wlcompositor"], {});
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);

        // --- wlterm (libkwl terminal) + forkpty'd dash script ---
        // dash prints READY, reads one line, echoes it back as GOT[<line>].
        // wlterm watches the grid for both markers and reports each once seen.
        const wltermExit = host.spawn(
          wltermBytes,
          [
            "wlterm",
            "--watch", "READY",
            "--watch", "GOT[a]",
            "dash", "-c",
            "printf 'READY\\n'; read x; printf 'GOT[%s]\\n' \"$x\"",
          ],
          { env: ["PATH=/usr/bin:/bin", "HOME=/root", "TERM=vt100"] },
        );

        // The window mapped and committed its first frame.
        await waitFor(out, "WLTERM_READY", 20_000, dump);
        // dash's "READY" flowed PTY → vt100_feed → grid.
        await waitFor(out, 'WLTERM_GRID "READY"', 20_000, dump);

        // Type "a" then Return on the keyboard (device 0). The compositor
        // routes each to the focused wlterm surface; libkwl compiles the
        // keycode to a keysym; vt100 maps it to bytes written to the PTY.
        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_A, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_ENTER, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_ENTER, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);

        // dash's `read x` got "a" and echoed GOT[a] back into the grid.
        await waitFor(out, 'WLTERM_GRID "GOT[a]"', 20_000, dump);

        // dash exits → PTY HUP → wlterm reaps it and shuts down cleanly.
        await waitFor(out, "WLTERM_EXIT code=0", 20_000, dump);

        const wltermCode = await Promise.race([
          wltermExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`wlterm timed out.\n${dump()}`)), 25_000)),
        ]);
        expect(wltermCode, `wlterm exit.\n${dump()}`).toBe(0);

        // The compositor exits once its last client disconnects.
        const compCode = await Promise.race([
          compExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`compositor timed out.\n${dump()}`)), 10_000)),
        ]);
        expect(compCode, `compositor exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    60_000,
  );
});
