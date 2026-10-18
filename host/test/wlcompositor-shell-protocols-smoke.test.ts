/**
 * The compositor's shell protocols — what Quickshell's shell needs from it
 * beyond layer-shell: hyprland-global-shortcuts-v1 (a `global` bind fires a
 * shortcut a client registered), ext-idle-notify-v1 (idled after a quiet
 * timeout, resumed on the next input), and ext-session-lock-v1 (a locked
 * session shows only the lock surface, gives it the keyboard, and unlocks
 * on the client's request).
 *
 * wlclient-test, run with WLC_SHELL=1, registers `wlclient-test:foo`, asks
 * for a 300 ms idle notification, maps a window, and locks the session once
 * the compositor fires the shortcut. A config file binds CTRL+F1 to the
 * shortcut. Everything is between client and compositor inside the kernel —
 * no host/src change. Skips if the binaries aren't built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { makeHostScratchTempRoot } from "./centralized-test-helper";

const compositorBin = tryResolveBinary("programs/wayland-demo/wlcompositor.wasm");
const clientBin = tryResolveBinary("programs/wlclient-test.wasm");
const hasBinaries = !!compositorBin && !!clientBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// evdev keycodes (linux/input-event-codes.h).
const EV_KEY = 0x01;
const EV_SYN = 0x00;
const SYN_REPORT = 0x00;
const KEY_A = 30;
const KEY_F1 = 59;
const KEY_LEFTCTRL = 29;

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function waitFor(
  ref: { value: string },
  needle: string | RegExp,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (typeof needle === "string" ? ref.value.includes(needle) : needle.test(ref.value)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${String(needle)}.\n${context()}`);
}

describe("wlcompositor — global shortcuts, idle notify, session lock", () => {
  it.skipIf(!hasBinaries)(
    "a bound shortcut reaches its client, idle fires and resumes, and the session locks and unlocks",
    async () => {
      const dir = makeHostScratchTempRoot("wlc-shell-");
      const confPath = join(dir, "wlcompositor.conf");
      writeFileSync(confPath, "bind = CTRL, F1, global, wlclient-test:foo\n");

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
      const tap = (code: number) => {
        host.injectInputEvent(0, EV_KEY, code, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, code, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);

        const compExit = host.spawn(loadBytes(compositorBin!), ["wlcompositor"], {
          env: ["WLC_LAYOUT=dwindle", `WLC_CONFIG=${confPath}`],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);
        expect(out.value).toContain("BINDS_LOADED n=1");

        const clientExit = host.spawn(loadBytes(clientBin!), ["wlclient-test"], {
          env: ["WLC_SHELL=1"],
        });
        await waitFor(out, "SHORTCUT_REGISTERED app=wlclient-test id=foo", 20_000, dump);
        await waitFor(out, "IDLE_NOTIFICATION timeout=300", 20_000, dump);
        await waitFor(out, "CLIENT_READY\n", 20_000, dump);

        // Nothing touches the seat for 300 ms: the notification idles. The
        // compositor reports it and the client hears the event.
        await waitFor(out, "IDLE timeout=300 idled", 5_000, dump);
        await waitFor(out, "IDLE_EVENT idled", 5_000, dump);

        // CTRL+F1 is bound to the client's shortcut: the compositor fires it
        // (press, then release on the key's release) and the key never
        // reaches the client's wl_keyboard. The input also ends the idle.
        host.injectInputEvent(0, EV_KEY, KEY_LEFTCTRL, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        tap(KEY_F1);
        host.injectInputEvent(0, EV_KEY, KEY_LEFTCTRL, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await waitFor(out, "SHORTCUT_PRESSED app=wlclient-test id=foo", 5_000, dump);
        await waitFor(out, "SHORTCUT_RELEASED app=wlclient-test id=foo", 5_000, dump);
        await waitFor(out, "SHORTCUT_EVENT released", 5_000, dump);
        await waitFor(out, "IDLE timeout=300 resumed", 5_000, dump);
        await waitFor(out, "IDLE_EVENT resumed", 5_000, dump);
        expect(out.value, `the bound key leaked to the client.\n${dump()}`)
          .not.toMatch(/GOT_KEY key=59/);

        // The shortcut's release makes the client lock the session. Its lock
        // surface is configured to the whole output, `locked` follows the
        // first blanked frame, and the keyboard moves to the lock surface.
        await waitFor(out, /LOCK_CONFIGURE w=(\d+) h=(\d+)/, 10_000, dump);
        const size = out.value.match(/LOCK_CONFIGURE w=(\d+) h=(\d+)/)!;
        expect(Number(size[1])).toBe(CANVAS_W);
        expect(Number(size[2])).toBe(CANVAS_H);
        await waitFor(out, "SESSION_LOCKED", 10_000, dump);
        await waitFor(out, "LOCK_EVENT locked", 10_000, dump);
        await waitFor(out, `LOCK_SURFACE w=${CANVAS_W} h=${CANVAS_H}`, 10_000, dump);

        // A key while locked lands on the lock surface, and the client
        // unlocks on it. The compositor hands the keyboard back.
        tap(KEY_A);
        await waitFor(out, "LOCK_KEY key=30", 10_000, dump);
        await waitFor(out, "SESSION_UNLOCKED", 10_000, dump);
        await waitFor(out, "SHELL_PROTOCOLS_OK", 10_000, dump);

        const clientCode = await Promise.race([
          clientExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`client timed out.\n${dump()}`)), 20_000)),
        ]);
        expect(clientCode, `client exit.\n${dump()}`).toBe(0);
        const compCode = await Promise.race([
          compExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`compositor timed out.\n${dump()}`)), 10_000)),
        ]);
        expect(compCode, `compositor exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
        rmSync(dir, { recursive: true, force: true });
      }
    },
    90_000,
  );
});
