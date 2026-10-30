/** Real labwc/wlroots pixman sessions, not a compositor protocol mock.
 * The existing Wayland probe proves mapped/presented server-decorated client
 * input and translated coordinates after an interactive floating move.
 * Browser coverage separately exercises the shipped foot desktop and GLES2.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { WLROOTS_ENV, compositorBytes, requireSession, sessionRootfs } from "./wlroots-session";

const client = resolveBinary("programs/wlclient-test.wasm");
const dash = resolveBinary("programs/dash.wasm");
requireSession("labwc");
const bytes = (path: string | URL) => new Uint8Array(readFileSync(path));
const text = (value: string) => new TextEncoder().encode(value);
const WIDTH = 1024, HEIGHT = 768;
// Standard upstream actions, including default Frame W-Left interactive Move:
// https://github.com/labwc/labwc/blob/0.20.2/docs/rc.xml.all
// MoveTo uses outer bounds: src/action.c adds ssd_thickness before view_move.
const config = `<labwc_config>
  <core><decoration>server</decoration></core>
  <keyboard><keybind key="C-S-e"><action name="Exit" /></keybind></keyboard>
  <mouse><default /></mouse>
  <windowRules><windowRule identifier="wlclient-test" serverDecoration="yes">
    <action name="MoveTo" x="100" y="100" />
  </windowRule></windowRules>
</labwc_config>`;
const fonts = `<fontconfig><dir>/usr/share/fonts</dir>
  <cachedir>/tmp/fontconfig</cachedir>
  <alias><family>sans</family><prefer><family>Inconsolata</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>Inconsolata</family></prefer></alias>
</fontconfig>`;

async function boundedExit(exit: Promise<number>, dump: () => string): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([exit, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`labwc exit timed out\n${dump()}`)), 30_000);
    })]);
  } finally { clearTimeout(timer); }
}

function latestMotion(stdout: string): { x: number; y: number } | undefined {
  const motions = [...stdout.matchAll(/GOT_MOTION x=(-?\d+) y=(-?\d+)/g)];
  const last = motions.at(-1);
  return last && { x: Number(last[1]), y: Number(last[2]) };
}

describe("labwc — real decorated floating sessions", () => {
  it("moves and focuses a presented client, exits cleanly and releases KMS for the next session", async () => {
    let stdout = "", stderr = "";
    const host = new NodeKernelHost({
      rootfsImage: await sessionRootfs("labwc", [
        { path: "/usr/bin/wlclient-test", bytes: bytes(client!), mode: 0o755 },
        { path: "/bin/sh", bytes: bytes(dash!), mode: 0o755 },
        { path: "/etc/xdg/labwc/rc.xml", bytes: text(config), mode: 0o644 },
        { path: "/usr/share/fonts/Inconsolata-Regular.ttf", bytes: bytes(new URL("../../third_party/Inconsolata-Regular.ttf", import.meta.url)), mode: 0o644 },
        { path: "/etc/fonts/fonts.conf", bytes: text(fonts), mode: 0o644 },
      ]),
      onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
      onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
    });
    const dump = () => `${stdout}\n--- stderr ---\n${stderr}`;
    const event = (device: number, type: number, code: number, value: number) => {
      host.injectInputEvent(device, type, code, value);
      host.injectInputEvent(device, 0, 0, 0);
    };
    const key = (code: number, value: number) => event(0, 1, code, value);
    const tap = (code: number) => { key(code, 1); key(code, 0); };
    const move = (x: number, y: number) => {
      host.injectInputEvent(1, 3, 0, x);
      host.injectInputEvent(1, 3, 1, y);
      host.injectInputEvent(1, 0, 0, 0);
    };
    const button = async (value: number) => {
      event(1, 1, 0x110, value);
      // libinput's physical button debounce needs distinct edges.
      await new Promise(resolve => setTimeout(resolve, 40));
    };
    const drain: Array<{ phase: string; completed: number; total: number }> = [];
    try {
      await host.init();
      host.setInputCanvasDims(WIDTH, HEIGHT);
      host.kmsSetDisplaySize(1, WIDTH, HEIGHT);
      const stats = new Int32Array(new SharedArrayBuffer(64));
      host.kmsAttachStats(1, stats.buffer as SharedArrayBuffer);
      let previousOwner = 0;
      // Reuse the same machine/display: a second start cannot acquire card0
      // if the first compositor still owns master or its native scanout.
      for (let session = 0; session < 2; session++) {
        const start = stdout.length;
        let pid = 0;
        const exit = host.spawn(compositorBytes("labwc"), ["labwc", "-s", "wlclient-test"], {
          env: [...WLROOTS_ENV, "PATH=/usr/bin:/bin", "HOME=/root", "WLC_DECOR=1", "FONTCONFIG_FILE=/etc/fonts/fonts.conf"],
          onStarted: value => { pid = value; },
        });
        const output = () => stdout.slice(start);
        await expect.poll(output, { timeout: 60_000, message: dump() }).toContain("CLIENT_READY\n");
        expect(output()).toContain("CONFIGURED");
        expect(output()).toContain("DECOR_MODE server_side");
        expect(output()).toMatch(/KEYMAP format=1 size=\d+ ok=1/);
        expect(output()).toMatch(/PRESENTED sec=\d+ nsec=\d+ refresh=\d+ seq=\d+/);
        await expect.poll(() => Atomics.load(stats, 8), { timeout: 30_000 }).toBe(pid);
        expect(pid).toBeGreaterThan(0);
        expect(pid).not.toBe(previousOwner);
        previousOwner = pid;

        move(145, 145); move(150, 150);
        await expect.poll(() => {
          const point = latestMotion(output());
          // Upstream MoveTo adds SSD left/top thickness to the requested
          // outer (100,100), so client y includes the titlebar offset.
          return point !== undefined && point.x >= 40 && point.x <= 50 && point.y > 0 && point.y < 50;
        }, { timeout: 30_000 }).toBe(true);
        // The standard modifier+drag binding moves a floating decorated
        // window without forwarding the drag button to its client.
        key(125, 1); // Super_L
        await button(1);
        move(170, 170);
        move(450, 330);
        await button(0);
        key(125, 0);
        const moved = stdout.length;
        move(445, 325); move(450, 330);
        await expect.poll(() => {
          const point = latestMotion(stdout.slice(moved));
          return point !== undefined && point.x > 0 && point.x < 200 && point.y > 0 && point.y < 150;
        }, { timeout: 30_000 }).toBe(true);
        expect(output()).not.toContain("GOT_BTN");
        tap(30); // a goes to the client focused by the interactive move.
        await expect.poll(output, { timeout: 30_000 }).toContain("GOT_KEY key=30 state=1");
        await button(1); await button(0);
        await expect.poll(output, { timeout: 30_000 }).toContain("GOT_BTN button=272 state=1");
        await expect.poll(output, { timeout: 30_000 }).toContain("CLIENT_OK key=30 btn=272");
        key(29, 1); key(42, 1); tap(18); key(42, 0); key(29, 0); // Ctrl+Shift+E
        expect(await boundedExit(exit, dump), dump()).toBe(0);
        await expect.poll(() => Atomics.load(stats, 8), { timeout: 30_000 }).toBe(0);
        await expect.poll(async () => (await host.enumProcs()).filter(proc => proc.pid === pid), { timeout: 30_000 }).toEqual([]);
      }
    } finally {
      host.subscribeDestroyProgress(progress => { drain.push(progress); });
      await host.destroy();
      const lastDrain = drain.findLast(progress => progress.phase === "draining");
      expect(lastDrain, "machine cleanup reports its cooperative drain").toBeDefined();
      expect(lastDrain!.completed, "no forced teardown of a live labwc session").toBe(lastDrain!.total);
    }
  }, 240_000);
});
