/**
 * zenity (programs/zenity.c): the file selection dialog rfd runs when no XDG
 * desktop portal answers. Each case runs zenity in a sway session: sway
 * floats the dialog, because its minimum size is its maximum size, and
 * `get_tree` says where it is once it has the focus. The test drives it with
 * evdev keys and clicks, and the session script reports zenity's status and
 * ends sway. Only zenity's own stdout is read, because that is what rfd
 * reads.
 *
 * /foo holds qux/, bar.png and baz.txt, so the list is
 * `..`, `qux`, `bar.png`, `baz.txt` before any filter.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { WLROOTS_ENV, compositorBytes, requireSession, sessionRootfs } from "./wlroots-session";

const zenityBin = resolveBinary("programs/wayland-demo/zenity.wasm");
const swaymsgBin = resolveBinary("programs/sway/swaymsg.wasm");
const dashBin = resolveBinary("programs/dash.wasm");
requireSession("sway");

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const SWAYSOCK = "/tmp/sway-ipc.sock";
const SESSION = "/etc/zenity-session";

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_ABS = 0x03;
const SYN_REPORT = 0x00;
const ABS_X = 0x00;
const ABS_Y = 0x01;
const KEY_ESC = 1;
const KEY_BACKSPACE = 14;
const KEY_TAB = 15;
const KEY_W = 17;
const KEY_E = 18;
const KEY_T = 20;
const KEY_ENTER = 28;
const KEY_LEFTCTRL = 29;
const KEY_X = 45;
const KEY_N = 49;
const KEY_DOT = 52;
const KEY_SPACE = 57;
const KEY_HOME = 102;
const KEY_END = 107;
const KEY_DOWN = 108;
const KEY_PAGEDOWN = 109;
const BTN_LEFT = 0x110;

// programs/zenity.c: the dialog's content size, where its list rows sit, and
// the centers of its footer buttons.
const WIN_W = 640;
const WIN_H = 420;
const LIST_Y = 68;
const ROW_H = 26;
const FOOTER_Y = 394;
const OPEN_X = 580;
const CANCEL_X = 472;
const FILTER_X = 108;

const row = (index: number): [number, number] => [320, LIST_Y + index * ROW_H + ROW_H / 2];

type Key =
  | number
  | { ctrl: number }
  | { hold: number; state: number }
  | { click: [number, number]; times?: number };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SwayNode {
  app_id?: string | null;
  focused: boolean;
  rect: Rect;
  window_rect: Rect;
  nodes: SwayNode[];
  floating_nodes: SwayNode[];
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
    ...[...node.nodes, ...node.floating_nodes].flatMap(windows),
  ];
}

const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;

async function fooImage(args: string[]): Promise<Uint8Array> {
  const session = `zenity ${args.map(quote).join(" ")}\necho "ZENITY_STATUS $?" >&2\nswaymsg -q exit\n`;
  const text = (value: string) => new TextEncoder().encode(value);
  const fs = KandeloImageFs.create();
  fs.loadImage(await sessionRootfs("sway", [
    { path: "/bin/sh", bytes: bytes(dashBin!), mode: 0o755 },
    { path: "/usr/bin/zenity", bytes: bytes(zenityBin!), mode: 0o755 },
    { path: "/usr/bin/swaymsg", bytes: bytes(swaymsgBin!), mode: 0o755 },
    { path: "/etc/sway/config", bytes: text(`default_floating_border none\nexec sh ${SESSION}\n`), mode: 0o644 },
    { path: SESSION, bytes: text(session), mode: 0o644 },
    { path: "/foo/bar.png", bytes: text("bar.png"), mode: 0o644 },
    { path: "/foo/baz.txt", bytes: text("baz.txt"), mode: 0o644 },
  ]));
  fs.mkdirWithOwner("/foo/qux", 0o755, 0, 0);
  return fs.saveImage();
}

async function runDialog(args: string[], keys: Key[], extraEnv: string[] = []): Promise<{ status: number; stdout: string }> {
  const err = { value: "" };
  const stdoutByPid = new Map<number, string>();
  const ipcPids = new Set<number>();
  const host = new NodeKernelHost({
    rootfsImage: await fooImage(args),
    onStdout: (pid, data) => {
      stdoutByPid.set(pid, (stdoutByPid.get(pid) ?? "") + new TextDecoder().decode(data));
    },
    onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
  });
  const dump = () => `--- stdout ---\n${[...stdoutByPid.values()].join("")}\n--- stderr ---\n${err.value}`;
  const env = [...WLROOTS_ENV, "PATH=/usr/bin:/bin", `SWAYSOCK=${SWAYSOCK}`, ...extraEnv];
  const key = (code: number, state: number) => {
    host.injectInputEvent(0, EV_KEY, code, state);
    host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
  };
  const focusedDialog = async (): Promise<SwayNode | undefined> => {
    const before = new Set(stdoutByPid.keys());
    const code = await host.spawn(arrayBuffer(swaymsgBin!), ["swaymsg", "-t", "get_tree"], { env });
    const replies = [...stdoutByPid].filter(([pid]) => !before.has(pid));
    for (const [pid] of replies) ipcPids.add(pid);
    if (code !== 0) return undefined;
    return windows(JSON.parse(replies.map(([, text]) => text).join(""))).find((node) => node.focused);
  };

  try {
    await host.init();
    host.setInputCanvasDims(CANVAS_W, CANVAS_H);
    const exit = host.spawn(compositorBytes("sway"), ["sway"], { env });

    let dialog: SwayNode | undefined;
    const deadline = Date.now() + 60_000;
    while (!(dialog = await focusedDialog())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the dialog.\n${dump()}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const { width: w, height: h } = dialog.window_rect;
    const x = dialog.rect.x + dialog.window_rect.x;
    const y = dialog.rect.y + dialog.window_rect.y;
    expect(w, dump()).toBe(WIN_W);
    expect(dialog.rect.x, dump()).toBe((CANVAS_W - dialog.rect.width) / 2);
    expect(dialog.rect.y, dump()).toBe((CANVAS_H - dialog.rect.height) / 2);

    for (const k of keys) {
      if (typeof k === "number") {
        key(k, 1);
        key(k, 0);
        continue;
      }
      if ("hold" in k) {
        key(k.hold, k.state);
        continue;
      }
      if ("click" in k) {
        // A titlebar, when the dialog draws one, sits above the content.
        host.injectInputEvent(1, EV_ABS, ABS_X, x + k.click[0]);
        host.injectInputEvent(1, EV_ABS, ABS_Y, y + h - WIN_H + k.click[1]);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        // sway loses a press that follows a pointer move closely; the cause
        // is not known, so the pointer rests before it clicks.
        await new Promise((r) => setTimeout(r, 400));
        // libinput drops a press that follows a release within its debounce
        // window as a bouncing button, so the clicks are spaced as a hand's.
        for (let i = 0; i < (k.times ?? 1); i++) {
          for (const state of [1, 0]) {
            host.injectInputEvent(1, EV_KEY, BTN_LEFT, state);
            host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
            await new Promise((r) => setTimeout(r, 120));
          }
        }
        continue;
      }
      key(KEY_LEFTCTRL, 1);
      key(k.ctrl, 1);
      key(k.ctrl, 0);
      key(KEY_LEFTCTRL, 0);
    }

    const swayCode = await Promise.race([
      exit,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error(`sway did not exit.\n${dump()}`)), 30_000)),
    ]);
    expect(swayCode, dump()).toBe(0);
    const status = /ZENITY_STATUS (\d+)/.exec(err.value);
    expect(status, dump()).not.toBeNull();
    const stdout = [...stdoutByPid].filter(([pid]) => !ipcPids.has(pid)).map(([, text]) => text).join("");
    return { status: Number(status![1]), stdout };
  } finally {
    await host.destroy().catch(() => {});
  }
}

describe("zenity --file-selection", () => {
  it("prints the chosen file and exits 0", async () => {
    const result = await runDialog(
      ["--file-selection", "--filename", "/foo/"], [KEY_DOWN, KEY_DOWN, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it("prints every marked file, separated by |", async () => {
    const result = await runDialog(
      ["--file-selection", "--multiple", "--filename", "/foo/"],
      [KEY_DOWN, KEY_DOWN, KEY_SPACE, KEY_DOWN, KEY_SPACE, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png|/foo/baz.txt\n" });
  }, 120_000);

  it("lists only the files the active filter matches", async () => {
    const result = await runDialog(
      ["--file-selection", "--file-filter", "Images | *.png", "--filename", "/foo/"],
      [KEY_END, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it("opens a folder with Enter and chooses a folder with Ctrl+Enter", async () => {
    const result = await runDialog(
      ["--file-selection", "--directory", "--filename", "/foo/"],
      [KEY_END, KEY_ENTER, { ctrl: KEY_ENTER }]);
    expect(result).toEqual({ status: 0, stdout: "/foo/qux\n" });
  }, 120_000);

  it("asks before a save replaces a file", async () => {
    const args = ["--file-selection", "--save", "--confirm-overwrite", "--filename", "/foo/bar.png"];
    expect(await runDialog(args, [KEY_ENTER, KEY_ENTER])).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
    expect(await runDialog(args, [KEY_ENTER, KEY_ESC, KEY_ESC])).toEqual({ status: 1, stdout: "" });
  }, 120_000);

  it("opens in $HOME without --filename", async () => {
    const result = await runDialog(["--file-selection"], [KEY_DOWN, KEY_DOWN, KEY_ENTER], ["HOME=/foo"]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it("saves under a typed name", async () => {
    const result = await runDialog(
      ["--file-selection", "--save", "--confirm-overwrite", "--filename", "/foo/"],
      [KEY_N, KEY_E, KEY_W, KEY_DOT, KEY_T, KEY_X, KEY_T, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/new.txt\n" });
  }, 120_000);

  it("goes to the parent folder with Backspace on an empty name", async () => {
    const result = await runDialog(
      ["--file-selection", "--filename", "/foo/qux/"], [KEY_BACKSPACE, KEY_DOWN, KEY_DOWN, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it("selects the next filter with Tab", async () => {
    const result = await runDialog(
      ["--file-selection", "--file-filter", "Images | *.png", "--file-filter", "Text | *.txt", "--filename", "/foo/"],
      [KEY_TAB, KEY_END, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/baz.txt\n" });
  }, 120_000);

  it("chooses a file with a double click", async () => {
    const result = await runDialog(["--file-selection", "--filename", "/foo/"], [{ click: row(2), times: 2 }]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it("moves with Page Down and Home", async () => {
    const args = ["--file-selection", "--filename", "/foo/"];
    expect(await runDialog(args, [KEY_PAGEDOWN, KEY_ENTER])).toEqual({ status: 0, stdout: "/foo/baz.txt\n" });
    expect(await runDialog(args, [KEY_END, KEY_HOME, KEY_DOWN, KEY_DOWN, KEY_ENTER]))
      .toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it("takes the Open, Cancel and filter buttons", async () => {
    const args = ["--file-selection", "--file-filter", "Images | *.png", "--file-filter", "Text | *.txt", "--filename", "/foo/"];
    expect(await runDialog(args, [KEY_END, { click: [OPEN_X, FOOTER_Y] }]))
      .toEqual({ status: 0, stdout: "/foo/bar.png\n" });
    expect(await runDialog(args, [{ click: [FILTER_X, FOOTER_Y] }, KEY_END, { click: [OPEN_X, FOOTER_Y] }]))
      .toEqual({ status: 0, stdout: "/foo/baz.txt\n" });
    expect(await runDialog(args, [{ click: [CANCEL_X, FOOTER_Y] }])).toEqual({ status: 1, stdout: "" });
  }, 180_000);

  it("marks files with Ctrl+click", async () => {
    const result = await runDialog(
      ["--file-selection", "--multiple", "--filename", "/foo/"],
      [{ hold: KEY_LEFTCTRL, state: 1 }, { click: row(2) }, { click: row(3) }, { hold: KEY_LEFTCTRL, state: 0 }, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png|/foo/baz.txt\n" });
  }, 120_000);

  it("prints nothing and exits 1 on Escape", async () => {
    const result = await runDialog(["--file-selection", "--filename", "/foo/"], [KEY_ESC]);
    expect(result).toEqual({ status: 1, stdout: "" });
  }, 120_000);

  it("refuses the other zenity modes and a missing value with status 255", async () => {
    const err = { value: "" };
    const host = new NodeKernelHost({
      onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
    });
    try {
      await host.init();
      expect(await host.spawn(arrayBuffer(zenityBin!), ["zenity", "--question"], {})).toBe(255);
      expect(err.value).toContain("zenity: --question is not supported");
      expect(await host.spawn(arrayBuffer(zenityBin!), ["zenity"], {})).toBe(255);
      expect(err.value).toContain("zenity: only --file-selection is supported");
      expect(await host.spawn(arrayBuffer(zenityBin!), ["zenity", "--file-selection", "--title"], {})).toBe(255);
      expect(err.value).toContain("zenity: --title needs a value");
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 60_000);
});
