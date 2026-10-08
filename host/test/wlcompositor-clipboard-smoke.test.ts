/**
 * The wlcompositor's selection: a real clipboard between Wayland clients.
 *
 * wlclip-test (programs/wlcompositor/wlclip-test.c) plays every role:
 *
 *   1. Copy and paste across clients. A maps, takes keyboard focus, and
 *      sets the selection through wl_data_device. B maps; the compositor
 *      offers B the selection BEFORE B's keyboard enter (the protocol's
 *      ordering, which a paste on the first key press depends on). B asks
 *      for the text with wl_data_offer.receive; the compositor forwards
 *      B's pipe to A as wl_data_source.send; A writes and closes; B reads
 *      to EOF. The bytes never pass through the compositor.
 *   2. Data control. A windowless client sets the selection through
 *      zwlr_data_control_manager_v1 — no focus, no serial. The source it
 *      replaces gets `cancelled`, and a newly focused window pastes the
 *      data-control text.
 *   3. sendshortcut. The Omarchy universal-clipboard binds send SUPER+V to
 *      the focused window as Ctrl+Shift+V when it is tagged `terminal`
 *      (by a windowrule on its app_id) and as Ctrl+V otherwise, with the
 *      chord's modifiers sent explicitly so the physically held SUPER does
 *      not leak into it.
 *
 * Skips if the binaries aren't built.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";
import { makeHostScratchTempRoot } from "./centralized-test-helper";

const compositorBin = tryResolveBinary("programs/wayland-demo/wlcompositor.wasm");
const clipBin = tryResolveBinary("programs/wlclip-test.wasm");
const kwlctlBin = tryResolveBinary("programs/kwlctl.wasm");
const hasBinaries = !!compositorBin && !!clipBin && !!kwlctlBin;

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// evdev keycodes (linux/input-event-codes.h).
const EV_KEY = 0x01;
const EV_SYN = 0x00;
const SYN_REPORT = 0x00;
const KEY_V = 47;
const KEY_C = 46;
const KEY_INSERT = 110;
const KEY_LEFTSHIFT = 42;
const KEY_LEFTCTRL = 29;
const KEY_LEFTMETA = 125;
// The client also logs the modifier presses themselves; the routing under
// test is in the mods of the other keys.
const MODIFIER_KEYS = new Set([KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_LEFTMETA]);
const keyPresses = (log: string) =>
  [...log.matchAll(/CLIP_KEY key=(\d+) state=1 mods=\S+/g)]
    .filter((m) => !MODIFIER_KEYS.has(Number(m[1])))
    .map((m) => m[0]);

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/** Stdout split by pid, so two instances of one client can be told apart. */
class Outputs {
  all = "";
  err = "";
  private byPid = new Map<number, string>();
  private pids = new Map<string, number>();

  stdout(pid: number, data: Uint8Array): void {
    const text = new TextDecoder().decode(data);
    this.all += text;
    this.byPid.set(pid, (this.byPid.get(pid) ?? "") + text);
  }
  name(label: string, pid: number): void {
    this.pids.set(label, pid);
  }
  of(label: string): string {
    const pid = this.pids.get(label);
    return pid === undefined ? "" : (this.byPid.get(pid) ?? "");
  }
  dump(): string {
    let s = `--- stdout ---\n${this.all}\n--- stderr ---\n${this.err}`;
    for (const [label, pid] of this.pids) {
      s += `\n--- ${label} (pid ${pid}) ---\n${this.byPid.get(pid) ?? ""}`;
    }
    return s;
  }
}

async function waitFor(
  read: () => string,
  needle: string | RegExp,
  timeoutMs: number,
  context: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const hit = () =>
    typeof needle === "string" ? read().includes(needle) : needle.test(read());
  while (Date.now() < deadline) {
    if (hit()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${needle}.\n${context()}`);
}

describe("wlcompositor — clipboard selection", () => {
  it.skipIf(!hasBinaries)(
    "transfers the selection between clients and through data-control",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clipBytes = loadBytes(clipBin!);

      const out = new Outputs();
      const host = new NodeKernelHost({
        onStdout: (pid, data) => out.stdout(pid, data),
        onStderr: (_pid, data) => { out.err += new TextDecoder().decode(data); },
      });
      const dump = () => out.dump();
      const run = (label: string, argv: string[]) =>
        host.spawn(clipBytes, ["wlclip-test", ...argv], {
          onStarted: (pid) => out.name(label, pid),
        });

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);
        host.spawn(compositorBytes, ["wlcompositor"], {}).catch(() => {});
        await waitFor(() => out.all, "COMPOSITOR_UP", 20_000, dump);

        // 1. A copies while focused.
        const copyText = "copied in window A";
        const copyExit = run("copy", ["copy", copyText]);
        await waitFor(() => out.of("copy"), "CLIP_COPY_SET", 20_000, dump);
        await waitFor(() => out.all, /SELECTION_SET via=data-device mimes=2/, 10_000, dump);

        // B maps, is offered A's selection ahead of its keyboard enter, and
        // pastes it through a pipe that A writes.
        const pasteExit = run("paste", ["paste"]);
        await waitFor(() => out.of("paste"), "CLIP_PASTED", 20_000, dump);
        const paste = out.of("paste");
        expect(paste, dump()).toContain(
          `CLIP_PASTED len=${copyText.length} text=${copyText}`,
        );
        expect(paste.indexOf("CLIP_OFFER"), dump()).toBeGreaterThanOrEqual(0);
        expect(paste.indexOf("CLIP_OFFER"), `offer must precede enter.\n${dump()}`)
          .toBeLessThan(paste.indexOf("CLIP_ENTER"));
        expect(paste, dump()).toContain("CLIP_OFFER mimes=2 text=yes focused=0");
        expect(out.of("copy"), dump()).toContain("CLIP_SENT mime=text/plain;charset=utf-8");
        expect(out.all, dump()).toContain("SELECTION_RECEIVE mime=text/plain;charset=utf-8");
        expect(await pasteExit, dump()).toBe(0);

        // 2. A windowless data-control client replaces the selection; A's
        // source is cancelled, and A exits on it.
        const controlText = "set through data-control";
        run("control", ["control-set", controlText]).catch(() => {});
        await waitFor(() => out.of("control"), "CLIP_CONTROL_SET", 20_000, dump);
        await waitFor(() => out.of("copy"), "CLIP_CANCELLED", 10_000, dump);
        expect(await copyExit, dump()).toBe(0);
        expect(out.all, dump()).toMatch(/SELECTION_SET via=data-control mimes=2/);
        // The data-control device saw its own selection: data-control
        // devices hear every change, focus or not.
        expect(out.of("control"), dump()).toContain("CLIP_CONTROL_SELECTION mimes=2");

        // A newly focused window pastes the data-control text.
        const paste2Exit = run("paste2", ["paste"]);
        await waitFor(() => out.of("paste2"), "CLIP_PASTED", 20_000, dump);
        expect(out.of("paste2"), dump()).toContain(
          `CLIP_PASTED len=${controlText.length} text=${controlText}`,
        );
        expect(await paste2Exit, dump()).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    90_000,
  );

  it.skipIf(!hasBinaries)(
    "SUPER+V, CTRL+V and the Insert chords route by terminal tag, without leaking SUPER",
    async () => {
      const compositorBytes = loadBytes(compositorBin!);
      const clipBytes = loadBytes(clipBin!);
      const kwlctlBytes = loadBytes(kwlctlBin!);

      // The clipboard binds and terminal windowrule the Omarchy config
      // ships (packages/registry/wayland-demo/desktops/data/omarchy/
      // wlcompositor.conf), standalone so this gate does not depend on the
      // rest of that file.
      const dir = makeHostScratchTempRoot("wlc-clip-");
      const confPath = join(dir, "wlcompositor.conf");
      writeFileSync(confPath, [
        "windowrule = tag +terminal, class:(Alacritty|kitty|com.mitchellh.ghostty|foot|org\\.codeberg\\.dnkl\\.foot|wezterm|org\\.omarchy\\..*|TUI\\..*)",
        "bind = SUPER, V, kandelo:sendshortcutiftag, terminal, CTRL SHIFT, V, CTRL, V",
        "bind = CTRL, V, kandelo:sendshortcutiftag, terminal, CTRL SHIFT, V, CTRL, V",
        "bind = SHIFT, Insert, kandelo:sendshortcutiftag, terminal, CTRL SHIFT, V, CTRL, V",
        "bind = CTRL, Insert, kandelo:sendshortcutiftag, terminal, CTRL SHIFT, C, CTRL, C",
        "bind = SUPER, A, sendshortcut, CTRL, A,",
        "",
      ].join("\n"));

      const out = new Outputs();
      const host = new NodeKernelHost({
        onStdout: (pid, data) => out.stdout(pid, data),
        onStderr: (_pid, data) => { out.err += new TextDecoder().decode(data); },
      });
      const dump = () => out.dump();
      const chord = (mod: number, key: number) => {
        host.injectInputEvent(0, EV_KEY, mod, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, key, 1);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, key, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
        host.injectInputEvent(0, EV_KEY, mod, 0);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
      };

      try {
        await host.init();
        host.setInputCanvasDims(CANVAS_W, CANVAS_H);
        host.spawn(compositorBytes, ["wlcompositor"], {
          env: [`WLC_CONFIG=${confPath}`],
        }).catch(() => {});
        await waitFor(() => out.all, "COMPOSITOR_UP", 20_000, dump);
        expect(out.all, dump()).toContain(`BINDS_LOADED n=5 source=${confPath}`);
        expect(out.all, dump()).toContain("WINDOWRULES_LOADED n=1");

        // An untagged window first. It stays up while the terminal comes and
        // goes: the compositor exits once its last client disconnects.
        const appExit = host.spawn(
          clipBytes, ["wlclip-test", "--app-id", "org.example.editor", "keys", "2"],
          { onStarted: (pid) => out.name("app", pid) },
        );
        await waitFor(() => out.of("app"), "CLIP_KEYS_READY", 20_000, dump);

        // A window whose app_id is foot's: tagged terminal. It maps last, so
        // it holds keyboard focus.
        const footExit = host.spawn(
          clipBytes, ["wlclip-test", "--app-id", "foot", "keys", "4"],
          { onStarted: (pid) => out.name("foot", pid) },
        );
        await waitFor(() => out.of("foot"), "CLIP_KEYS_READY", 20_000, dump);

        await host.spawn(kwlctlBytes, ["kwlctl", "activewindow"], {});
        expect(out.all, dump()).toMatch(/"class":"foot"[^\n]*"tags":\["terminal"\]/);

        // SUPER+V reaches foot as exactly Ctrl+Shift+V, and the release
        // carries the same chord; SUPER is not part of it.
        chord(KEY_LEFTMETA, KEY_V);
        await waitFor(() => out.of("foot"), `CLIP_KEY key=${KEY_V} state=0`, 10_000, dump);
        expect(out.of("foot"), dump()).toContain(
          `CLIP_KEY key=${KEY_V} state=1 mods=ctrl+shift\n`,
        );
        expect(out.of("foot"), dump()).toContain(
          `CLIP_KEY key=${KEY_V} state=0 mods=ctrl+shift\n`,
        );
        expect(out.all, dump()).toMatch(/SENDSHORTCUT app_id=foot mods=0x6 key=47/);

        // CTRL+V (the browser-usable mirror) and SHIFT+Insert do the same
        // for a terminal; CTRL+Insert becomes the terminal's copy chord.
        chord(KEY_LEFTCTRL, KEY_V);
        chord(KEY_LEFTSHIFT, KEY_INSERT);
        chord(KEY_LEFTCTRL, KEY_INSERT);
        expect(await footExit, dump()).toBe(0);
        expect(keyPresses(out.of("foot")), dump()).toEqual([
          `CLIP_KEY key=${KEY_V} state=1 mods=ctrl+shift`,
          `CLIP_KEY key=${KEY_V} state=1 mods=ctrl+shift`,
          `CLIP_KEY key=${KEY_V} state=1 mods=ctrl+shift`,
          `CLIP_KEY key=${KEY_C} state=1 mods=ctrl+shift`,
        ]);

        // Focus falls back to the untagged window, which gets plain Ctrl+V
        // from the same bind.
        await waitFor(() => out.of("app"), /CLIP_ENTER[\s\S]*CLIP_ENTER/, 10_000, dump);
        chord(KEY_LEFTMETA, KEY_V);
        chord(KEY_LEFTCTRL, KEY_INSERT);
        expect(await appExit, dump()).toBe(0);
        expect(keyPresses(out.of("app")), dump()).toEqual([
          `CLIP_KEY key=${KEY_V} state=1 mods=ctrl`,
          `CLIP_KEY key=${KEY_C} state=1 mods=ctrl`,
        ]);
        expect(out.of("app"), dump()).not.toMatch(/key=47 state=1 mods=\S*super/);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    90_000,
  );
});
