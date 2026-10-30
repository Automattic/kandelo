/**
 * sway, the i3-compatible wlroots compositor, tiles the clients its config
 * starts, routes input to the window under the pointer, answers its IPC
 * socket, and runs its own bar and message clients.
 *
 * Beyond the platform path cage exercises (libseat, libudev-zero, legacy
 * KMS, libinput, pixman over dumb buffers), this covers what sway adds:
 *
 *   - its config's `exec` forks and runs each command through /bin/sh;
 *   - two windows split the output side by side, as `get_tree` reports;
 *   - a click focuses the window under the pointer, so each client gets a
 *     key and a button;
 *   - swaymsg speaks i3 IPC over sway's Unix socket, and `exit` ends the
 *     session with status 0;
 *   - sway forks swaybar and swaynag with one end of a socketpair as
 *     WAYLAND_SOCKET, and each maps a layer surface that takes space from
 *     the tiles;
 *   - swaybar reads its status line from a forked status_command, and a
 *     swaynag button runs its action through /bin/sh.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { WLROOTS_ENV, compositorBytes, requireSession, sessionRootfs } from "./wlroots-session";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INCONSOLATA = join(__dirname, "../../third_party/Inconsolata-Regular.ttf");

const swaymsgBin = resolveBinary("programs/sway/swaymsg.wasm");
const swaybarBin = resolveBinary("programs/sway/swaybar.wasm");
const swaynagBin = resolveBinary("programs/sway/swaynag.wasm");
const clientBin = resolveBinary("programs/wlclient-test.wasm");
const dashBin = resolveBinary("programs/dash.wasm");
requireSession("sway");

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const SWAYSOCK = "/tmp/sway-ipc.sock";

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

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const ABS_X = 0x00;
const ABS_Y = 0x01;
const KEY_A = 30;
const BTN_LEFT = 0x110;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SwayNode {
  app_id?: string | null;
  rect: Rect;
  window_rect: Rect;
  nodes: SwayNode[];
}

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function arrayBuffer(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function windows(node: SwayNode): SwayNode[] {
  return [
    ...(node.app_id ? [node] : []),
    ...node.nodes.flatMap(windows),
  ];
}

async function waitFor(
  ref: { value: string },
  done: (text: string) => boolean,
  what: string,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(ref.value)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}.\n${context()}`);
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

/** A machine whose /etc/sway/config is `config`, with sh, the test client,
 *  sway's programs on PATH and a monospace font for swaybar and swaynag. */
async function startSway(config: string) {
  const out = { value: "" };
  const err = { value: "" };
  const stdoutByPid = new Map<number, string>();
  const events: unknown[] = [], syscalls: unknown[] = [];
  const progress: Array<{ time: number; phase: string; completed: number; total: number }> = [];
  const checkpoints: Array<{ time: number; phase: string }> = [];
  const trace = process.env.KANDELO_SWAY_TRACE === "1";
  const id = createHash("sha256").update(config).digest("hex").slice(0,12);
  let before: unknown[] = [];
  const checkpoint = (phase: string) => {
    if (!trace) return;
    checkpoints.push({ time: Date.now(), phase });
    // Preserve the last completed phase even if enumeration or destroy never
    // returns; writing only from finally loses the evidence of that stall.
    writeFileSync(join(__dirname, `../../.context/sway-node-teardown-${id}.json`),
      JSON.stringify({config,before,checkpoints,events,progress,syscalls,stdout:out.value,stderr:err.value},
        (_key,value) => typeof value === "bigint" ? value.toString() : value,2)+"\n");
  };
  checkpoint("rootfs-start");
  const host = new NodeKernelHost({
    onProcessEvent: event => events.push({time:Date.now(),...event}),
    rootfsImage: await sessionRootfs("sway", [
      { path: "/bin/sh", bytes: bytes(dashBin!), mode: 0o755 },
      { path: "/usr/bin/wlclient-test", bytes: bytes(clientBin!), mode: 0o755 },
      { path: "/usr/bin/swaymsg", bytes: bytes(swaymsgBin!), mode: 0o755 },
      { path: "/usr/bin/swaybar", bytes: bytes(swaybarBin!), mode: 0o755 },
      { path: "/usr/bin/swaynag", bytes: bytes(swaynagBin!), mode: 0o755 },
      { path: `${FONT_DIR}/Inconsolata-Regular.ttf`, bytes: bytes(INCONSOLATA), mode: 0o644 },
      { path: "/etc/fonts/fonts.conf", bytes: new TextEncoder().encode(FONTS_CONF), mode: 0o644 },
      { path: "/etc/sway/config", bytes: new TextEncoder().encode(config), mode: 0o644 },
    ]),
    onStdout: (pid, data) => {
      const text = new TextDecoder().decode(data);
      out.value += text;
      stdoutByPid.set(pid, (stdoutByPid.get(pid) ?? "") + text);
    },
    onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
  });
  const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
  const env = [...WLROOTS_ENV, "PATH=/usr/bin:/bin", `SWAYSOCK=${SWAYSOCK}`];
  const swaymsg = async (...args: string[]) => {
    checkpoint(`swaymsg-start:${args.join(" ")}`);
    const before = new Set(stdoutByPid.keys());
    const code = await host.spawn(arrayBuffer(swaymsgBin!), ["swaymsg", ...args], { env });
    checkpoint(`swaymsg-finished:${args.join(" ")}`);
    expect(code, `swaymsg ${args.join(" ")}.\n${dump()}`).toBe(0);
    return [...stdoutByPid].filter(([pid]) => !before.has(pid)).map(([, text]) => text).join("");
  };
  const tiles = async () => windows(JSON.parse(await swaymsg("-t", "get_tree")));
  const waitForWorkspace = async (done: (rect: Rect) => boolean, what: string) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const [workspace] = JSON.parse(await swaymsg("-t", "get_workspaces"));
      if (done(workspace.rect)) return workspace.rect as Rect;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Timed out waiting for ${what}.\n${dump()}`);
  };
  const press = (code: number) => {
    host.injectInputEvent(0, EV_KEY, code, 1);
    host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
    host.injectInputEvent(0, EV_KEY, code, 0);
    host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
  };
  const click = (x: number, y: number) => {
    host.injectInputEvent(1, EV_ABS, ABS_X, x);
    host.injectInputEvent(1, EV_ABS, ABS_Y, y);
    host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
    host.injectInputEvent(1, EV_KEY, BTN_LEFT, 1);
    host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
    host.injectInputEvent(1, EV_KEY, BTN_LEFT, 0);
    host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
  };

  checkpoint("host-init-start");
  await host.init();
  checkpoint("host-init-finished");
  const offSyscalls = process.env.KANDELO_SWAY_TRACE === "1" ? host.subscribeSyscalls(event => {
    syscalls.push(event); if (syscalls.length > 256) syscalls.shift();
  }) : undefined;
  host.setInputCanvasDims(CANVAS_W, CANVAS_H);
  checkpoint("sway-spawn-start");
  const exited = host.spawn(compositorBytes("sway"), ["sway"], { env });
  const exitCode = () => {
    checkpoint("sway-exit-wait");
    return Promise.race([
      exited,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error(`sway timed out.\n${dump()}`)), 30_000)),
    ]).then(code => { checkpoint("sway-exited"); return code; });
  };

  const close = async () => {
    checkpoint("close-enum-procs-start");
    before = trace ? await host.enumProcs() : [];
    checkpoint("close-enum-procs-finished");
    host.subscribeDestroyProgress(event => {
      progress.push({time:Date.now(),...event});
      checkpoint(`destroy-${event.phase}:${event.completed}/${event.total}`);
    });
    try {
      checkpoint("destroy-start");
      await host.destroy();
      checkpoint("destroy-finished");
      const drain = progress.findLast(event => event.phase === "draining");
      expect(drain, "destroy must report its cooperative drain").toBeDefined();
      expect(drain!.completed, "sway session forced termination after an incomplete drain").toBe(drain!.total);
    } finally {
      offSyscalls?.();
      checkpoint("close-finished");
    }
  };
  return { host, out, err, dump, env, tiles, waitForWorkspace, press, click, exitCode, close, checkpoint };
}

describe("sway — a wlroots tiling compositor runs a client session", () => {
  it(
    "tiles two clients, routes input to each, answers IPC, and exits with status 0",
    async () => {
      const sway = await startSway("exec wlclient-test\nexec wlclient-test\n");
      try {
        const { out, dump } = sway;
        await waitFor(out, (t) => count(t, "CLIENT_READY\n") === 2,
          "two mapped clients", 60_000, dump);

        const tree = await sway.tiles();
        expect(tree.map((w) => w.app_id)).toEqual(["wlclient-test", "wlclient-test"]);
        const [left, right] = [...tree].sort((a, b) => a.rect.x - b.rect.x);
        expect(left.rect.x).toBe(0);
        expect(right.rect.x).toBe(left.rect.width);
        expect(left.rect.width + right.rect.width).toBe(CANVAS_W);
        expect(left.rect.height).toBe(right.rect.height);

        // The clients keep a 200x150 surface whatever size sway configures,
        // and sway places it at the top-left of its tile. A click focuses
        // the surface under the pointer; the left client then takes the
        // first key and exits, and keyboard focus passes to the right one.
        const clickInside = (w: SwayNode) =>
          sway.click(w.rect.x + w.window_rect.x + 50, w.rect.y + w.window_rect.y + 50);
        // libinput debounces a release that follows its press closely, so
        // each click is let through before the pointer moves on.
        clickInside(right);
        await waitFor(out, (t) => count(t, "GOT_BTN") === 2,
          "the right client's click", 30_000, dump);
        clickInside(left);
        await waitFor(out, (t) => count(t, "GOT_BTN") === 4,
          "the left client's click", 30_000, dump);
        sway.press(KEY_A);
        await waitFor(out, (t) => count(t, "CLIENT_OK") === 1,
          "the left client to get a key and a button", 30_000, dump);
        sway.press(KEY_A);
        await waitFor(out, (t) => count(t, "CLIENT_OK") === 2,
          "the right client to get a key and a button", 30_000, dump);

        // sway queues each IPC reply until its loop next polls the socket,
        // and `exit` stops the loop first, so swaymsg reports no reply.
        await sway.host.spawn(arrayBuffer(swaymsgBin!), ["swaymsg", "exit"], { env: sway.env });
        expect(await sway.exitCode(), `sway exit.\n${dump()}`).toBe(0);
      } finally {
        await sway.close();
      }
    },
    180_000,
  );

  it(
    "runs swaybar at the bottom of the output with its status_command",
    async () => {
      const sway = await startSway(`bar {
  status_command echo BAR_STATUS >&2 && echo ready
}
exec wlclient-test
`);
      try {
        sway.checkpoint("client-ready-wait");
        await waitFor(sway.out, (t) => t.includes("CLIENT_READY\n"),
          "a mapped client", 60_000, sway.dump);
        sway.checkpoint("bar-workspace-wait");
        const workspace = await sway.waitForWorkspace((r) => r.height < CANVAS_H,
          "swaybar to reserve its height");
        expect(workspace.y).toBe(0);
        expect(workspace.width).toBe(CANVAS_W);
        sway.checkpoint("bar-status-wait");
        await waitFor(sway.err, (t) => t.includes("BAR_STATUS"),
          "swaybar's status_command", 30_000, sway.dump);

        sway.checkpoint("bar-exit-command-start");
        await sway.host.spawn(arrayBuffer(swaymsgBin!), ["swaymsg", "exit"], { env: sway.env });
        sway.checkpoint("bar-exit-command-finished");
        expect(await sway.exitCode(), `sway exit.\n${sway.dump()}`).toBe(0);
      } finally {
        await sway.close();
      }
    },
    180_000,
  );

  it(
    "shows config errors in swaynag, whose Exit sway button ends the session",
    async () => {
      const sway = await startSway("not_a_sway_command\nexec wlclient-test\n");
      try {
        sway.checkpoint("client-ready-wait");
        await waitFor(sway.out, (t) => t.includes("CLIENT_READY\n"),
          "a mapped client", 60_000, sway.dump);
        sway.checkpoint("nag-workspace-wait");
        const workspace = await sway.waitForWorkspace((r) => r.y > 0,
          "swaynag to reserve its height");
        const nagHeight = workspace.y;
        expect(workspace.y + workspace.height).toBe(CANVAS_H);

        // swaynag lays its buttons out from the right edge: the 21-pixel
        // dismiss button, a 35-pixel gap, then "Exit sway", whose 9
        // Inconsolata glyphs at 10 points span about 60 pixels.
        sway.checkpoint("nag-exit-click");
        sway.click(CANVAS_W - 90, Math.floor(nagHeight / 2));
        expect(await sway.exitCode(), `sway exit.\n${sway.dump()}`).toBe(0);
      } finally {
        await sway.close();
      }
    },
    180_000,
  );
});
