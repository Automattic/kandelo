/**
 * Upstream swayidle 1.9.1 watches a sway session through ext-idle-notify-v1
 * and runs its commands through /bin/sh.
 *
 * The flow, and what each step proves:
 *
 *   - sway's config `exec` forks swayidle, which binds the idle notifier
 *     and asks for a notification after one second without input;
 *   - with no input, sway reports the seat idle and swayidle forks sh to
 *     run the `timeout` command;
 *   - one key press makes the seat active again, and swayidle runs the
 *     `resume` command;
 *   - swaymsg `exit` ends the session with status 0.
 *
 * Requires the normal sway, swayidle and shell package artifacts. A
 * missing artifact is a provisioning failure, not passing or skipped
 * coverage.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { WLROOTS_ENV, compositorBytes, requireSession, sessionRootfs } from "./wlroots-session";

const swayidleBin = resolveBinary("programs/swayidle.wasm");
const swaymsgBin = resolveBinary("programs/sway/swaymsg.wasm");
const dashBin = resolveBinary("programs/dash.wasm");
requireSession("sway");

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const SWAYSOCK = "/tmp/sway-ipc.sock";

const CONFIG = "exec swayidle -w timeout 1 'echo IDLE_TIMEOUT' resume 'echo IDLE_RESUME'\n";

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_A = 30;

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for "${needle}".\n${context()}`);
}

describe("swayidle — upstream idle manager on sway", () => {
  it(
    "runs its timeout command when the seat is idle and its resume command on input",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        rootfsImage: await sessionRootfs("sway", [
          { path: "/bin/sh", bytes: bytes(dashBin!), mode: 0o755 },
          { path: "/usr/bin/swayidle", bytes: bytes(swayidleBin!), mode: 0o755 },
          { path: "/etc/sway/config", bytes: new TextEncoder().encode(CONFIG), mode: 0o644 },
        ]),
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
      const env = [...WLROOTS_ENV, "PATH=/usr/bin:/bin", `SWAYSOCK=${SWAYSOCK}`];

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);
        const swayExit = host.spawn(compositorBytes("sway"), ["sway"], { env });

        await waitFor(out, "IDLE_TIMEOUT", 60_000, dump);
        expect(out.value, `resume before any input.\n${dump()}`).not.toContain("IDLE_RESUME");

        host.injectInputEvent(0, EV_KEY, KEY_A, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, KEY_A, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        await waitFor(out, "IDLE_RESUME", 30_000, dump);

        const swaymsg = readFileSync(swaymsgBin!);
        await host.spawn(
          swaymsg.buffer.slice(swaymsg.byteOffset, swaymsg.byteOffset + swaymsg.byteLength),
          ["swaymsg", "exit"],
          { env },
        );
        const swayCode = await Promise.race([
          swayExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`sway timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(swayCode, `sway exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    180_000,
  );
});
