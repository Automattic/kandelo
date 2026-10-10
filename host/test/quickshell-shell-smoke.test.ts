/**
 * The Omarchy shell: one Quickshell process on wlcompositor and a dbus-daemon
 * session bus, running the image's shell.qml from
 * packages/registry/wayland-demo/desktops/data/quickshell. What the desktop
 * script starts is what runs here, on fixture themes and .desktop entries.
 *
 * The gates walk the shell's surfaces and protocols end to end: the
 * wallpaper and bar map on layer-shell, the shortcuts register over
 * hyprland-global-shortcuts and the compositor's `global` binds fire them,
 * the notification server owns org.freedesktop.Notifications and shows what
 * notify-send sends, the launcher filters and launches through the Hyprland
 * IPC, a theme switch reaches the shell through the compositor's event
 * socket, and the lock screen locks the session through ext-session-lock and
 * refuses a password the image's credential check rejects. The unlock with
 * the demo user's real password runs against the shell image in the browser
 * spec (this host has no /etc/shadow for it). Skips if the binaries aren't
 * built.
 */
import { describe, expect, it } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";
import { tryResolveBinary } from "../src/binary-resolver";

const REPO_ROOT = join(__dirname, "../..");
const INCONSOLATA = join(REPO_ROOT, "third_party/Inconsolata-Regular.ttf");
const SHELL_QML = join(
  REPO_ROOT,
  "packages/registry/wayland-demo/desktops/data/quickshell/shell.qml",
);

const compositorBin = tryResolveBinary("programs/wayland-demo/wlcompositor.wasm");
const dashBin = tryResolveBinary("programs/dash.wasm");
const daemonBin = tryResolveBinary("programs/dbus/dbus-daemon.wasm");
const quickshellBin = tryResolveBinary("programs/quickshell.wasm");
const notifyBin = tryResolveBinary("programs/wayland-demo/notify-send.wasm");
const loginBin = join(REPO_ROOT, "local-binaries/test-fixtures/wasm32/login.wasm");
const hasBinaries =
  !!compositorBin && !!dashBin && !!daemonBin && !!quickshellBin &&
  !!notifyBin && existsSync(loginBin);

const CANVAS_W = 1920;
const CANVAS_H = 1080;

// evdev keycodes (linux/input-event-codes.h).
const EV_KEY = 0x01;
const EV_SYN = 0x00;
const SYN_REPORT = 0x00;
const KEY_ESC = 1;
const KEY_BACKSPACE = 14;
const KEY_W = 17;
const KEY_A = 30;
const KEY_X = 45;
const KEY_ENTER = 28;
const KEY_SPACE = 57;
const KEY_DOWN = 108;
const KEY_LEFTCTRL = 29;
const KEY_LEFTSHIFT = 42;
const KEY_LEFTALT = 56;

// Unique per run: the kernel's /tmp is host-backed and persists across
// hosts, so a failed run's leftovers would collide with the next.
const RUN = `${process.pid}`;
const BUS_SOCKET = `/tmp/dbus-qs-${RUN}.socket`;
const NOTIFY_FLAG = `/tmp/qs-notify-${RUN}`;
const STOP_FLAG = `/tmp/qs-stop-${RUN}`;

const SESSION_CONF = `<busconfig>
  <type>session</type>
  <listen>unix:path=${BUS_SOCKET}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>`;

const THEME_CONF = (title: string, accent: string) => `# ${title}
border_active = ${accent}
wallpaper_top = 0x101010
wallpaper_bottom = 0x202020
bar = 0x181818
foreground = 0xe0e0e0
muted = 0x808080
accent = ${accent}
occupied = 0x303030
background = 0x141414
gaps_in = 4
gaps_out = 8
`;

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
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${String(needle)}.\n${context()}`);
}

describe("quickshell — the Omarchy shell on wlcompositor + dbus", () => {
  it.skipIf(!hasBinaries)(
    "maps its bar and wallpaper, owns the shortcuts, notifications, launcher, themes and the lock screen",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kandelo-qs-shell-"));
      const fontDir = join(root, "fonts");
      const themesDir = join(root, "themes");
      const appsDir = join(root, "share", "applications");
      const dashTarget = join(root, "dash.wasm");
      const notifyTarget = join(root, "notify-send.wasm");
      const loginTarget = join(root, "login.wasm");
      mkdirSync(fontDir);
      mkdirSync(appsDir, { recursive: true });
      symlinkSync(dashBin!, dashTarget);
      symlinkSync(notifyBin!, notifyTarget);
      symlinkSync(loginBin, loginTarget);
      for (const [name, title, accent] of [["bar", "Bar", "0x7aa2f7"], ["foo", "Foo", "0xf7768e"]]) {
        mkdirSync(join(themesDir, name), { recursive: true });
        writeFileSync(join(themesDir, name, "theme.conf"), THEME_CONF(title, accent));
      }
      writeFileSync(
        join(appsDir, "waldo.desktop"),
        `[Desktop Entry]\nType=Application\nName=Waldo\nExec=${dashTarget} -c true\n`,
      );
      writeFileSync(
        join(appsDir, "qux.desktop"),
        `[Desktop Entry]\nType=Application\nName=Qux\nExec=${dashTarget} -c true\n`,
      );
      copyFileSync(INCONSOLATA, join(fontDir, "Inconsolata-Regular.ttf"));
      const fontsConf = join(root, "fonts.conf");
      writeFileSync(
        fontsConf,
        `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${join(root, "fontcache")}</cachedir>
  <alias>
    <family>sans-serif</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
  <alias>
    <family>monospace</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`,
      );
      const confPath = join(root, "wlcompositor.conf");
      writeFileSync(
        confPath,
        [
          "theme = bar",
          `notify = ${notifyTarget}`,
          "bind = CTRL, space, global, quickshell:launcher",
          "bind = CTRL ALT, space, global, quickshell:menu",
          "bind = CTRL, Escape, global, quickshell:lock",
          "bind = CTRL SHIFT, space, theme, next",
          "",
        ].join("\n"),
      );

      // The session: the bus, then the shell on it; notify-send once the
      // test says the shell is up; the shell killed once the test is done,
      // which leaves the session locked (the protocol forbids unlocking for
      // a lock client that dies).
      const script = [
        `printf '%s\\n' '${SESSION_CONF}' > /tmp/qs-session-${RUN}.conf`,
        `${daemonBin!} --config-file=/tmp/qs-session-${RUN}.conf --nofork &`,
        `daemon_pid=$!`,
        `i=0; while [ ! -S ${BUS_SOCKET} ] && [ $i -lt 20000 ]; do i=$((i+1)); done`,
        `export DBUS_SESSION_BUS_ADDRESS=unix:path=${BUS_SOCKET}`,
        `${quickshellBin!} -p ${SHELL_QML} &`,
        `qs_pid=$!`,
        `while [ ! -f ${NOTIFY_FLAG} ]; do j=0; while [ $j -lt 2000 ]; do j=$((j+1)); done; done`,
        `${notifyTarget} Theme bar || echo NOTIFY_FAILED`,
        `while [ ! -f ${STOP_FLAG} ]; do j=0; while [ $j -lt 2000 ]; do j=$((j+1)); done; done`,
        `kill $qs_pid`,
        `wait $qs_pid`,
        `echo QS_EXIT=$?`,
        `kill $daemon_pid`,
        `exit 0`,
      ].join("\n");

      const out = { value: "" };
      const err = { value: "" };
      const host = new NodeKernelHost({
        execProgramBytes: {
          [dashTarget]: loadBytes(dashBin!),
          [notifyTarget]: loadBytes(notifyBin!),
          [loginTarget]: loadBytes(loginBin),
        },
        onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
        onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
      });
      const dump = () => `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}`;
      const press = (code: number, down: number) => {
        host.injectInputEvent(0, EV_KEY, code, down);
        host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
      };
      const tap = (code: number) => { press(code, 1); press(code, 0); };
      const chord = (mods: number[], code: number) => {
        for (const m of mods) press(m, 1);
        tap(code);
        for (const m of [...mods].reverse()) press(m, 0);
      };

      try {
        await host.init();

        const compExit = host.spawn(loadBytes(compositorBin!), ["wlcompositor"], {
          env: [
            "WLC_LAYOUT=dwindle",
            `WLC_CONFIG=${confPath}`,
            `WLC_THEME_DIR=${themesDir}`,
            `DBUS_SESSION_BUS_ADDRESS=unix:path=${BUS_SOCKET}`,
          ],
        });
        await waitFor(out, "COMPOSITOR_UP", 20_000, dump);
        expect(out.value).toContain("THEME bar");

        const dashExit = host.spawn(loadBytes(dashBin!), ["dash", "-c", script], {
          env: [
            "PATH=/bin",
            `HOME=${root}`,
            "XDG_RUNTIME_DIR=/tmp",
            "XKB_CONFIG_ROOT=/tmp",
            `XDG_DATA_DIRS=${join(root, "share")}`,
            `FONTCONFIG_FILE=${fontsConf}`,
            "QT_QUICK_BACKEND=software",
            "HYPRLAND_INSTANCE_SIGNATURE=wlcompositor",
            `KANDELO_THEME_DIR=${themesDir}`,
            `KANDELO_LOGIN=${loginTarget}`,
            "USER=maker",
          ],
        });

        // Gate 1: the shell is up. Its wallpaper is a background-layer
        // surface, its bar a top-layer strip across the top, its three
        // shortcuts are registered, its idle monitor armed, and it read the
        // compositor's current theme over the Hyprland request socket.
        await waitFor(out, "SHELL_READY", 120_000, dump);
        await waitFor(out, /LAYER ns=wallpaper layer=0 x=0 y=0 w=1920 h=1080/, 60_000, dump);
        await waitFor(out, /LAYER ns=bar layer=2 x=0 y=0 w=1920 h=(\d+)/, 60_000, dump);
        const barHeight = Number(out.value.match(/LAYER ns=bar layer=2 x=0 y=0 w=1920 h=(\d+)/)![1]);
        expect(barHeight).toBeGreaterThan(0);
        for (const id of ["launcher", "menu", "lock"])
          await waitFor(out, `SHORTCUT_REGISTERED app=quickshell id=${id}`, 30_000, dump);
        await waitFor(out, "IDLE_NOTIFICATION timeout=600000", 30_000, dump);
        await waitFor(out, "SHELL_THEME name=bar", 30_000, dump);
        await waitFor(out, "HYPR_LISTENER slot=", 30_000, dump);

        // Gate 2: the notification server. notify-send's Notify round trip
        // resolves with the first id, the shell tracks it and maps the card
        // as an overlay-layer surface.
        writeFileSync(NOTIFY_FLAG, "");
        await waitFor(out, "NOTIFY_ID id=1", 60_000, dump);
        await waitFor(out, "NOTIFICATION id=1 summary=Theme", 30_000, dump);
        await waitFor(out, /LAYER ns=notifications layer=3 /, 30_000, dump);
        expect(out.value).not.toContain("NOTIFY_FAILED");

        // Gate 3: the launcher. CTRL+Space fires the shortcut; the launcher
        // maps as an overlay surface with the keyboard, lists the two
        // .desktop entries, narrows to Waldo on "wa", widens on Backspace, and
        // Enter launches it through the compositor (dispatch exec) and
        // dismisses.
        chord([KEY_LEFTCTRL], KEY_SPACE);
        await waitFor(out, "SHORTCUT_PRESSED app=quickshell id=launcher", 10_000, dump);
        await waitFor(out, /LAYER ns=launcher layer=3 /, 30_000, dump);
        await waitFor(out, "LAUNCHER_READY n=2", 30_000, dump);
        tap(KEY_W);
        await waitFor(out, "LAUNCHER_FILTER q=w n=1", 10_000, dump);
        tap(KEY_A);
        await waitFor(out, "LAUNCHER_FILTER q=wa n=1", 10_000, dump);
        tap(KEY_BACKSPACE);
        await waitFor(out, /LAUNCHER_FILTER q=wa n=1[\s\S]*LAUNCHER_FILTER q=w n=1/, 10_000, dump);
        tap(KEY_ENTER);
        await waitFor(out, `LAUNCHER_EXEC cmd=${dashTarget} -c true`, 10_000, dump);
        await waitFor(out, `KWLCTL_EXEC "${dashTarget}"`, 10_000, dump);
        await waitFor(out, "LAUNCHER_EXIT", 10_000, dump);

        // Gate 4: a theme switch. CTRL+SHIFT+Space cycles the compositor's
        // theme; the shell hears `theme>>` on the event socket, re-reads the
        // palette, and shows the switch on its on-screen display.
        chord([KEY_LEFTCTRL, KEY_LEFTSHIFT], KEY_SPACE);
        await waitFor(out, "THEME foo", 10_000, dump);
        await waitFor(out, "SHELL_THEME name=foo", 30_000, dump);
        await waitFor(out, "OSD Theme=Foo", 30_000, dump);
        await waitFor(out, /LAYER ns=osd layer=3 /, 30_000, dump);
        // The switch spawned the configured notifier too.
        await waitFor(out, "NOTIFY_ID id=2", 60_000, dump);

        // Gate 5: the menu. CTRL+ALT+Space opens the launcher at its root;
        // Down+Enter descends into the themes, Escape climbs back to the
        // root, and Enter on a theme switches back to bar.
        chord([KEY_LEFTCTRL, KEY_LEFTALT], KEY_SPACE);
        await waitFor(out, "SHORTCUT_PRESSED app=quickshell id=menu", 10_000, dump);
        await waitFor(out, /LAUNCHER_LEVEL root[\s\S]*LAYER ns=launcher layer=3 /, 30_000, dump);
        tap(KEY_DOWN);
        tap(KEY_ENTER);
        await waitFor(out, "LAUNCHER_LEVEL themes", 10_000, dump);
        tap(KEY_ESC);
        await waitFor(out, /LAUNCHER_LEVEL themes[\s\S]*LAUNCHER_LEVEL root/, 10_000, dump);
        tap(KEY_DOWN);
        tap(KEY_ENTER);
        await waitFor(out, /LAUNCHER_LEVEL root[\s\S]*LAUNCHER_LEVEL themes[\s\S]*LAUNCHER_LEVEL root[\s\S]*LAUNCHER_LEVEL themes/, 10_000, dump);
        tap(KEY_ENTER);
        await waitFor(out, "LAUNCHER_THEME name=bar", 10_000, dump);
        await waitFor(out, /SHELL_THEME name=foo[\s\S]*SHELL_THEME name=bar/, 30_000, dump);

        // Gate 6: the lock screen. CTRL+Escape locks the session; the
        // compositor blanks the output, gives the lock surface the keyboard,
        // and announces `locked` after the blanked frame flipped. A password
        // goes to the image's credential check, which this host cannot
        // satisfy (no /etc/shadow here), so the session stays locked.
        chord([KEY_LEFTCTRL], KEY_ESC);
        await waitFor(out, "SHORTCUT_PRESSED app=quickshell id=lock", 10_000, dump);
        await waitFor(out, "LOCK_ENGAGED", 30_000, dump);
        await waitFor(out, "SESSION_LOCKED", 30_000, dump);
        await waitFor(out, `LOCK_SURFACE w=${CANVAS_W} h=${CANVAS_H}`, 30_000, dump);
        tap(KEY_X);
        tap(KEY_ENTER);
        await waitFor(out, "LOCK_ATTEMPT ok=0", 60_000, dump);
        expect(out.value).not.toContain("SESSION_UNLOCKED");

        // The shell dies while the session is locked: the compositor keeps
        // it locked rather than exposing the desktop.
        writeFileSync(STOP_FLAG, "");
        await waitFor(out, "SESSION_LOCK_CLIENT_GONE", 30_000, dump);
        await waitFor(out, /QS_EXIT=\d+/, 30_000, dump);
        expect(out.value).not.toContain("SESSION_UNLOCKED");

        const dashCode = await Promise.race([
          dashExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`dash timed out.\n${dump()}`)), 30_000)),
        ]);
        expect(dashCode, `dash exit.\n${dump()}`).toBe(0);
        const compCode = await Promise.race([
          compExit,
          new Promise<number>((_, reject) =>
            setTimeout(() => reject(new Error(`compositor timed out.\n${dump()}`)), 15_000)),
        ]);
        expect(compCode, `compositor exit.\n${dump()}`).toBe(0);
      } finally {
        await host.destroy().catch(() => {});
      }
    },
    300_000,
  );
});
