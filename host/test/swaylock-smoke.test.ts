/**
 * Upstream swaylock 1.8.6 locks a sway session through ext-session-lock-v1
 * and checks the typed password against /etc/shadow.
 *
 * The flow, and what each step proves:
 *
 *   - sway runs as the unprivileged user maker, and its config `exec`
 *     runs the setuid-root swaylock: exec raises the effective uid to 0,
 *     swaylock reads maker's hash from the root-only /etc/shadow, then
 *     drops back to maker and confirms that it cannot regain root;
 *   - swaylock forks its password child (fork instrumentation at work),
 *     locks the session, and reports the lock on its --ready-fd;
 *   - host-injected keys reach swaylock through the lock surface's
 *     keyboard focus; a wrong password leaves the session locked;
 *   - the right password unlocks the session, swaylock exits 0, and
 *     swaymsg `exit` ends the session with status 0.
 *
 * Requires the normal sway, swaylock and shell package artifacts. A
 * missing artifact is a provisioning failure, not passing or skipped
 * coverage.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { WLROOTS_ENV, compositorBytes, requireSession, sessionRootfs } from "./wlroots-session";
import { DEMO_LOGIN_PASSWORD, DEMO_LOGIN_PASSWORD_HASH } from "../../images/vfs/lib/demo-login";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INCONSOLATA = join(__dirname, "../../third_party/Inconsolata-Regular.ttf");

const swaylockBin = resolveBinary("programs/swaylock.wasm");
const swaymsgBin = resolveBinary("programs/sway/swaymsg.wasm");
const dashBin = resolveBinary("programs/dash.wasm");
requireSession("sway");

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const SWAYSOCK = "/tmp/sway-ipc.sock";
const MAKER = 1000;

const FONT_DIR = "/usr/share/fonts";
const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${FONT_DIR}</dir>
  <cachedir>/tmp/fontconfig</cachedir>
  <alias>
    <family>monospace</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`;

// swaylock writes a newline to --ready-fd once the session is locked. Its
// stdout goes to stderr, so the pipe carries only that newline.
const LOCK_SESSION = `{ swaylock --ready-fd 3 3>&1 1>&2; echo SWAYLOCK_EXIT=$? >&2; } |
  { read line && echo SWAYLOCK_LOCKED >&2; }
`;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEYS: Record<string, number> = {
  a: 30, d: 32, e: 18, f: 33, k: 37, l: 38, n: 49, o: 24, "\n": 28,
};

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function arrayBuffer(path: string): ArrayBuffer {
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
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for "${needle}".\n${context()}`);
}

describe("swaylock — upstream screen locker on sway", () => {
  it(
    "locks the session, refuses a wrong password, and unlocks with the shadow password",
    async () => {
      const out = { value: "" };
      const err = { value: "" };
      const encode = (text: string) => new TextEncoder().encode(text);
      const host = new NodeKernelHost({
        rootfsImage: await sessionRootfs("sway", [
          { path: "/bin/sh", bytes: bytes(dashBin!), mode: 0o755 },
          { path: "/usr/bin/swaylock", bytes: bytes(swaylockBin!), mode: 0o4755 },
          { path: "/usr/bin/lock-session", bytes: encode(LOCK_SESSION), mode: 0o755 },
          {
            path: "/etc/passwd",
            bytes: encode("root:x:0:0:root:/root:/bin/sh\nmaker:x:1000:1000:maker:/tmp:/bin/sh\n"),
            mode: 0o644,
          },
          {
            path: "/etc/shadow",
            bytes: encode(`root:*:0:0:99999:7:::\nmaker:${DEMO_LOGIN_PASSWORD_HASH}:0:0:99999:7:::\n`),
            mode: 0o640,
          },
          { path: "/etc/group", bytes: encode("root:x:0:\nmaker:x:1000:\n"), mode: 0o644 },
          { path: `${FONT_DIR}/Inconsolata-Regular.ttf`, bytes: bytes(INCONSOLATA), mode: 0o644 },
          { path: "/etc/fonts/fonts.conf", bytes: encode(FONTS_CONF), mode: 0o644 },
          { path: "/etc/sway/config", bytes: encode("exec sh /usr/bin/lock-session\n"), mode: 0o644 },
        ]),
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
      const env = [...WLROOTS_ENV, "PATH=/usr/bin:/bin", "HOME=/tmp", `SWAYSOCK=${SWAYSOCK}`];
      const type = (text: string) => {
        for (const char of text) {
          host.injectInputEvent(0, EV_KEY, KEYS[char]!, 1);
          host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
          host.injectInputEvent(0, EV_KEY, KEYS[char]!, 0);
          host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        }
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);
        const swayExit = host.spawn(compositorBytes("sway"), ["sway"], {
          env,
          uid: MAKER,
          gid: MAKER,
        });

        await waitFor(err, "SWAYLOCK_LOCKED", 60_000, dump);

        // swaylock's password child sleeps 2 s after every check, so the
        // refusal has settled well before the next password goes in.
        type("foo\n");
        await new Promise((r) => setTimeout(r, 5000));
        expect(err.value, `a wrong password unlocked the session.\n${dump()}`)
          .not.toContain("SWAYLOCK_EXIT=");

        type(`${DEMO_LOGIN_PASSWORD}\n`);
        await waitFor(err, "SWAYLOCK_EXIT=0", 30_000, dump);

        await host.spawn(arrayBuffer(swaymsgBin!), ["swaymsg", "exit"], {
          env,
          uid: MAKER,
          gid: MAKER,
        });
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
