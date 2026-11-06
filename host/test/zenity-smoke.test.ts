/**
 * zenity (programs/zenity.c): the file selection dialog rfd runs when no XDG
 * desktop portal answers. Each case runs `wlcompositor zenity ARGS...`, so the
 * dialog is the kiosk session: the compositor centers it (its DIALOG marker
 * says it is mapped and focused), the test drives it with evdev keys, and the
 * compositor exits with zenity's status. Only zenity's own stdout is read,
 * because that is what rfd reads.
 *
 * /foo holds qux/, bar.png and baz.txt, so the list is
 * `..`, `qux`, `bar.png`, `baz.txt` before any filter.
 *
 * Skips if the binaries aren't built (bare checkout).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NodeKernelHost, resolveRootfsArtifact } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

const compositorBin = tryResolveBinary("programs/wayland-demo/wlcompositor.wasm");
const zenityBin = tryResolveBinary("programs/wayland-demo/zenity.wasm");
const hasBinaries = !!compositorBin && !!zenityBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

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

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function fooImage(): Promise<Uint8Array> {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(resolveRootfsArtifact().selectedPath)));
  fs.mkdirWithOwner("/foo", 0o755, 0, 0);
  fs.mkdirWithOwner("/foo/qux", 0o755, 0, 0);
  for (const name of ["bar.png", "baz.txt"])
    fs.createFileWithOwner(`/foo/${name}`, 0o644, 0, 0, new TextEncoder().encode(name));
  fs.createFileWithOwner("/usr/bin/zenity", 0o755, 0, 0, new Uint8Array(readFileSync(zenityBin!)));
  return fs.saveImage();
}

async function waitFor(ref: { value: string }, needle: RegExp, timeoutMs: number,
                       context: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (needle.test(ref.value)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${needle}.\n${context()}`);
}

async function runDialog(args: string[], keys: Key[], env?: string[]): Promise<{ status: number; stdout: string }> {
  const out = { value: "" };
  const err = { value: "" };
  const chunks: { pid: number; text: string }[] = [];
  const host = new NodeKernelHost({
    rootfsImage: await fooImage(),
    onStdout: (pid, data) => {
      const text = new TextDecoder().decode(data);
      out.value += text;
      chunks.push({ pid, text });
    },
    onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
  });
  const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
  const key = (code: number, state: number) => {
    host.injectInputEvent(0, EV_KEY, code, state);
    host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
  };

  try {
    await host.init();
    host.setInputCanvasDims(CANVAS_W, CANVAS_H);
    const exit = host.spawn(loadBytes(compositorBin!), ["wlcompositor", "/usr/bin/zenity", ...args], { env });

    await waitFor(out, /DIALOG "[^"]*" x=\d+ y=\d+ w=640 h=\d+/, 30_000, dump);
    const [x, y, w, h] = /DIALOG "[^"]*" x=(\d+) y=(\d+) w=(\d+) h=(\d+)/.exec(out.value)!.slice(1).map(Number);
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
        host.injectInputEvent(1, EV_ABS, ABS_X, x + (w - 640) + k.click[0]);
        host.injectInputEvent(1, EV_ABS, ABS_Y, y + h - WIN_H + k.click[1]);
        host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
        // libinput drops a press that follows a release within its debounce
        // window as a bouncing button, so the clicks are spaced as a hand's.
        for (let i = 0; i < (k.times ?? 1); i++) {
          for (const state of [1, 0]) {
            host.injectInputEvent(1, EV_KEY, BTN_LEFT, state);
            host.injectInputEvent(1, EV_SYN, SYN_REPORT, 0);
            await new Promise((r) => setTimeout(r, 60));
          }
        }
        continue;
      }
      key(KEY_LEFTCTRL, 1);
      key(k.ctrl, 1);
      key(k.ctrl, 0);
      key(KEY_LEFTCTRL, 0);
    }

    const status = await Promise.race([
      exit,
      new Promise<number>((_, reject) =>
        setTimeout(() => reject(new Error(`zenity did not exit.\n${dump()}`)), 30_000)),
    ]);
    const session = /SESSION "[^"]*" pid=(\d+)/.exec(out.value);
    expect(session, dump()).not.toBeNull();
    const stdout = chunks.filter((c) => c.pid === Number(session![1])).map((c) => c.text).join("");
    return { status, stdout };
  } finally {
    await host.destroy().catch(() => {});
  }
}

describe("zenity --file-selection", () => {
  it.skipIf(!hasBinaries)("prints the chosen file and exits 0", async () => {
    const result = await runDialog(
      ["--file-selection", "--filename", "/foo/"], [KEY_DOWN, KEY_DOWN, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("prints every marked file, separated by |", async () => {
    const result = await runDialog(
      ["--file-selection", "--multiple", "--filename", "/foo/"],
      [KEY_DOWN, KEY_DOWN, KEY_SPACE, KEY_DOWN, KEY_SPACE, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png|/foo/baz.txt\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("lists only the files the active filter matches", async () => {
    const result = await runDialog(
      ["--file-selection", "--file-filter", "Images | *.png", "--filename", "/foo/"],
      [KEY_END, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("opens a folder with Enter and chooses a folder with Ctrl+Enter", async () => {
    const result = await runDialog(
      ["--file-selection", "--directory", "--filename", "/foo/"],
      [KEY_END, KEY_ENTER, { ctrl: KEY_ENTER }]);
    expect(result).toEqual({ status: 0, stdout: "/foo/qux\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("asks before a save replaces a file", async () => {
    const args = ["--file-selection", "--save", "--confirm-overwrite", "--filename", "/foo/bar.png"];
    expect(await runDialog(args, [KEY_ENTER, KEY_ENTER])).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
    expect(await runDialog(args, [KEY_ENTER, KEY_ESC, KEY_ESC])).toEqual({ status: 1, stdout: "" });
  }, 120_000);

  it.skipIf(!hasBinaries)("opens in $HOME without --filename", async () => {
    const result = await runDialog(["--file-selection"], [KEY_DOWN, KEY_DOWN, KEY_ENTER], ["HOME=/foo"]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("saves under a typed name", async () => {
    const result = await runDialog(
      ["--file-selection", "--save", "--confirm-overwrite", "--filename", "/foo/"],
      [KEY_N, KEY_E, KEY_W, KEY_DOT, KEY_T, KEY_X, KEY_T, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/new.txt\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("goes to the parent folder with Backspace on an empty name", async () => {
    const result = await runDialog(
      ["--file-selection", "--filename", "/foo/qux/"], [KEY_BACKSPACE, KEY_DOWN, KEY_DOWN, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("selects the next filter with Tab", async () => {
    const result = await runDialog(
      ["--file-selection", "--file-filter", "Images | *.png", "--file-filter", "Text | *.txt", "--filename", "/foo/"],
      [KEY_TAB, KEY_END, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/baz.txt\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("chooses a file with a double click", async () => {
    const result = await runDialog(["--file-selection", "--filename", "/foo/"], [{ click: row(2), times: 2 }]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("moves with Page Down and Home", async () => {
    const args = ["--file-selection", "--filename", "/foo/"];
    expect(await runDialog(args, [KEY_PAGEDOWN, KEY_ENTER])).toEqual({ status: 0, stdout: "/foo/baz.txt\n" });
    expect(await runDialog(args, [KEY_END, KEY_HOME, KEY_DOWN, KEY_DOWN, KEY_ENTER]))
      .toEqual({ status: 0, stdout: "/foo/bar.png\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("takes the Open, Cancel and filter buttons", async () => {
    const args = ["--file-selection", "--file-filter", "Images | *.png", "--file-filter", "Text | *.txt", "--filename", "/foo/"];
    expect(await runDialog(args, [KEY_END, { click: [OPEN_X, FOOTER_Y] }]))
      .toEqual({ status: 0, stdout: "/foo/bar.png\n" });
    expect(await runDialog(args, [{ click: [FILTER_X, FOOTER_Y] }, KEY_END, { click: [OPEN_X, FOOTER_Y] }]))
      .toEqual({ status: 0, stdout: "/foo/baz.txt\n" });
    expect(await runDialog(args, [{ click: [CANCEL_X, FOOTER_Y] }])).toEqual({ status: 1, stdout: "" });
  }, 180_000);

  it.skipIf(!hasBinaries)("marks files with Ctrl+click", async () => {
    const result = await runDialog(
      ["--file-selection", "--multiple", "--filename", "/foo/"],
      [{ hold: KEY_LEFTCTRL, state: 1 }, { click: row(2) }, { click: row(3) }, { hold: KEY_LEFTCTRL, state: 0 }, KEY_ENTER]);
    expect(result).toEqual({ status: 0, stdout: "/foo/bar.png|/foo/baz.txt\n" });
  }, 120_000);

  it.skipIf(!hasBinaries)("prints nothing and exits 1 on Escape", async () => {
    const result = await runDialog(["--file-selection", "--filename", "/foo/"], [KEY_ESC]);
    expect(result).toEqual({ status: 1, stdout: "" });
  }, 120_000);

  it.skipIf(!hasBinaries)("refuses the other zenity modes and a missing value with status 255", async () => {
    const err = { value: "" };
    const host = new NodeKernelHost({
      onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
    });
    try {
      await host.init();
      expect(await host.spawn(loadBytes(zenityBin!), ["zenity", "--question"], {})).toBe(255);
      expect(err.value).toContain("zenity: --question is not supported");
      expect(await host.spawn(loadBytes(zenityBin!), ["zenity"], {})).toBe(255);
      expect(err.value).toContain("zenity: only --file-selection is supported");
      expect(await host.spawn(loadBytes(zenityBin!), ["zenity", "--file-selection", "--title"], {})).toBe(255);
      expect(err.value).toContain("zenity: --title needs a value");
    } finally {
      await host.destroy().catch(() => {});
    }
  }, 60_000);
});
