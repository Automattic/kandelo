/**
 * Omarchy's menu and theme switcher run on sway through the package's
 * omarchy-shell and fuzzel.
 *
 * The Logout flow, and what each step proves:
 *
 *   - sway's config `exec`s Omarchy's own `omarchy-menu toggle system`, which
 *     sends the QuickShell IPC call `shell toggle omarchy.menu`; the
 *     package's omarchy-shell answers it with omarchy-menu-fuzzel;
 *   - the driver reads the package's omarchy-menu.jsonc and shows the
 *     System entries in fuzzel --dmenu;
 *   - typing "logo" leaves only Logout, and Enter runs Omarchy's
 *     omarchy-system-logout, which closes the windows and runs
 *     `swaymsg exit`, so sway ends with status 0.
 *
 * The theme flow, and what each step proves:
 *
 *   - `omarchy-menu summon theme` runs the menu's Theme action, Omarchy's
 *     omarchy-theme-switcher, whose image selector call omarchy-shell
 *     answers with a fuzzel list of the themes;
 *   - the image selector caches its rows without libvips, so the next open
 *     skips the per-image work;
 *   - typing "gruv" leaves only Gruvbox, and Enter runs omarchy-theme-set,
 *     which renders the package's templates, records the theme name, links
 *     the theme's first background, a JPEG, starts swaybg on it, and reloads
 *     sway; swaybg reads the JPEG through gdk-pixbuf without an error;
 *   - sway's reload reads the rendered sway.conf through the session
 *     config's `include`, so the `omarchy` bar reports Gruvbox's colors.
 *
 * The bindings flow, and what each step proves:
 *
 *   - lua runs omarchy-sway-bindings, which loads Omarchy's own
 *     default/hypr Lua binding files and prints them as sway binds; it
 *     skips the calls omarchy-shell --check says nothing answers;
 *   - sway's reload reads them through the session config's `include`,
 *     and omarchy-menu-keybindings lists them from sway's config;
 *   - SUPER + ESCAPE runs the generated bind, which opens the System menu,
 *     and Logout ends sway with status 0.
 *
 * The notification flow, and what each step proves:
 *
 *   - Omarchy's omarchy-notification-send calls Notify through busctl,
 *     which is basuctl, on a dbus-daemon session bus where mako owns
 *     org.freedesktop.Notifications;
 *   - it prints the id mako assigns, and makoctl lists the notification
 *     with its summary, app name and urgency.
 *
 * The loading flow, and what each step proves:
 *
 *   - `omarchy-theme-switcher --preload`, which the session runs at start,
 *     caches the picker's rows, and omarchy-shell answers the shell's
 *     image-selector preload call;
 *   - the menu's Theme action shows mako's "Loading Theme…" notification
 *     while the switcher starts, and omarchy-shell dismisses it before
 *     fuzzel opens the picker;
 *   - the root menu shows mako's "Loading Menu…" notification while it
 *     builds its rows, and it is dismissed once fuzzel opens the menu.
 *
 * Requires the normal omarchy, sway, swaybg, fuzzel, bash, coreutils, jq,
 * sed, grep, gawk, findutils, diffutils, busybox, lua-cli, basuctl, dbus
 * and mako package artifacts. A missing artifact is a provisioning
 * failure, not passing or skipped coverage.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { extractZipEntry, parseZipCentralDirectory } from "../../../../host/src/vfs/zip";
import { COREUTILS_NAMES } from "../../../../images/vfs/lib/init/shell-binaries";
import { WLROOTS_ENV, compositorBytes, requireSession, sessionRootfs } from "../../../../host/test/wlroots-session";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INCONSOLATA = join(__dirname, "../../../../third_party/Inconsolata-Regular.ttf");
const PASSWD = join(__dirname, "../../../../images/rootfs/etc/passwd");

const omarchyZip = resolveBinary("programs/omarchy/omarchy.zip");
const fuzzelBin = resolveBinary("programs/fuzzel.wasm");
const swaymsgBin = resolveBinary("programs/sway/swaymsg.wasm");
const swaybgBin = resolveBinary("programs/swaybg.wasm");
const bashBin = resolveBinary("programs/bash.wasm");
const coreutilsBin = resolveBinary("programs/coreutils.wasm");
const jqBin = resolveBinary("programs/jq.wasm");
const sedBin = resolveBinary("programs/sed.wasm");
const grepBin = resolveBinary("programs/grep.wasm");
const gawkBin = resolveBinary("programs/gawk.wasm");
const findBin = resolveBinary("programs/findutils/find.wasm");
const cmpBin = resolveBinary("programs/diffutils/cmp.wasm");
const busyboxBin = resolveBinary("programs/busybox.wasm");
const luaBin = resolveBinary("programs/lua.wasm");
const basuctlBin = resolveBinary("programs/basuctl.wasm");
const dbusDaemonBin = resolveBinary("programs/dbus/dbus-daemon.wasm");
const makoBin = resolveBinary("programs/mako/mako.wasm");
const makoctlBin = resolveBinary("programs/mako/makoctl.wasm");
const desktopLauncher = resolveBinary("programs/wayland-demo/omarchydesktop");
const desktopData = resolveBinary("programs/wayland-demo/kandelo-desktop-data.zip");
requireSession("sway");

const CANVAS_W = 1920;
const CANVAS_H = 1080;
const SWAYSOCK = "/tmp/sway-ipc.sock";
const OMARCHY_PATH = "/usr/share/omarchy";
const STATE = "/tmp/.local/state/omarchy/current";

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

const THEME_CONFIG = `include ${STATE}/theme/sway.conf
exec bash /etc/sway/theme-report
`;

/** The bar's background in the theme's rendered Waybar style. */
const BAR_BACKGROUND = `grep -A1 'window#waybar' ${STATE}/theme/waybar.css | grep -o '#[0-9a-f][0-9a-f]*'`;

const THEME_REPORT = `omarchy-menu summon theme
echo "theme=$(cat ${STATE}/theme.name)"
echo "background=$(readlink ${STATE}/background)"
echo "bar=$(${BAR_BACKGROUND})"
compgen -G "$HOME/.cache/omarchy/image-selector/*.rows" >/dev/null && echo "rows=cached"
for pid in $(pgrep -x swaybg); do echo "swaybg=$(tr '\\0' ' ' </proc/$pid/cmdline)"; done
sleep 10
swaymsg exit
`;

/** Omarchy runs the user's theme-set hook with the theme's name once the
 *  theme is applied; this one reports it to omarchydesktop's event log.
 *  HOME is on the /tmp tmpfs, which hides the image's /tmp, so the desktop's
 *  launch copies the hook from the image into place. */
const THEME_HOOK = "/etc/sway/theme-hook";
const THEME_HOOK_REPORT = `swaymsg -t send_tick "theme=$1 bar=$(${BAR_BACKGROUND})"
`;
const DESKTOP_LAUNCH = `mkdir -p $HOME/.config/omarchy/hooks
cp ${THEME_HOOK} $HOME/.config/omarchy/hooks/theme-set
exec bash /usr/bin/omarchydesktop`;

const BINDINGS = "/tmp/.local/state/omarchy/sway/bindings.conf";

const BINDINGS_CONFIG = `include ${BINDINGS}
exec bash /etc/sway/bindings-report
`;

const BINDINGS_REPORT = `mkdir -p "$(dirname ${BINDINGS})"
omarchy-sway-bindings >${BINDINGS} 2>/tmp/bindings.skipped
swaymsg reload
sed 's/^/skipped: /' /tmp/bindings.skipped
omarchy-menu-keybindings --print | tr -s ' ' | sed 's/^/menu: /'
echo bindings-ready
`;

const BUS_SOCKET = `/tmp/dbus-omarchy-${process.pid}.socket`;

const SESSION_BUS = `<busconfig>
  <type>session</type>
  <listen>unix:path=${BUS_SOCKET}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;

const NOTIFICATION_REPORT = `dbus-daemon --config-file=/etc/dbus-1/session.conf --nofork &
until [ -S ${BUS_SOCKET} ]; do sleep 0.1; done
export DBUS_SESSION_BUS_ADDRESS=unix:path=${BUS_SOCKET}
mako &
for try in $(seq 60); do
  id=$(omarchy-notification-send -p -u critical -g X foo bar 2>/tmp/notification.err) && break
  sleep 0.5
done
sed 's/^/notification error: /' /tmp/notification.err
echo "id=$id"
makoctl list | sed 's/^/mako: /'
swaymsg exit
`;

const LOADING_REPORT = `dbus-daemon --config-file=/etc/dbus-1/session.conf --nofork &
until [ -S ${BUS_SOCKET} ]; do sleep 0.1; done
export DBUS_SESSION_BUS_ADDRESS=unix:path=${BUS_SOCKET}
mako &
until makoctl list >/dev/null 2>&1; do sleep 0.1; done
omarchy-theme-switcher --preload && echo "preload=ok"
compgen -G "$HOME/.cache/omarchy/image-selector/*.rows" >/dev/null && echo "rows=cached"
omarchy-shell image-selector preload "" "" true true && echo "shell-preload=ok"
omarchy-menu summon theme &
menu=$!
until makoctl list | grep -q 'Loading Theme…'; do sleep 0.1; done
echo "loading=shown"
until pgrep -x fuzzel >/dev/null; do sleep 0.1; done
echo "loading-with-picker=$(makoctl list | grep -c 'Loading Theme…')"
wait $menu
echo "theme=$(cat ${STATE}/theme.name)"
swaymsg exit
`;

const MENU_LOADING_REPORT = `dbus-daemon --config-file=/etc/dbus-1/session.conf --nofork &
until [ -S ${BUS_SOCKET} ]; do sleep 0.1; done
export DBUS_SESSION_BUS_ADDRESS=unix:path=${BUS_SOCKET}
mako &
until makoctl list >/dev/null 2>&1; do sleep 0.1; done
omarchy-menu summon &
menu=$!
until pgrep -x fuzzel >/dev/null; do sleep 0.1; done
while makoctl list | grep -q 'Loading Menu…'; do sleep 0.1; done
echo "loading=$(makoctl history | grep -c 'Loading Menu…')"
pkill -x fuzzel
wait $menu
swaymsg exit
`;

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const SYN_REPORT = 0x00;
const KEY_ESC = 1;
const KEY_LEFTCTRL = 29;
const KEY_LEFTSHIFT = 42;
const KEY_SPACE = 57;
const KEY_BACKSPACE = 14;
const KEY_Q = 16;
const KEY_R = 19;
const KEY_U = 22;
const KEY_O = 24;
const KEY_ENTER = 28;
const KEY_G = 34;
const KEY_L = 38;
const KEY_V = 47;
const KEY_LEFTMETA = 125;

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function zipFiles(path: string, root: string) {
  const zip = bytes(path);
  return parseZipCentralDirectory(zip)
    .filter((entry) => !entry.isDirectory && !entry.isSymlink)
    .map((entry) => ({
      path: `${root}/${entry.fileName}`,
      bytes: extractZipEntry(zip, entry),
      mode: entry.mode & 0o777 || 0o644,
    }));
}

function zipLinks(path: string, root: string) {
  const zip = bytes(path);
  return parseZipCentralDirectory(zip)
    .filter((entry) => entry.isSymlink)
    .map((entry) => ({
      path: `${root}/${entry.fileName}`,
      target: new TextDecoder().decode(extractZipEntry(zip, entry)),
    }));
}

/** The background files `theme`'s archive links name: the omarchy package's
 *  runtime files, which the shell image registers as lazy files. */
function themeBackgrounds(theme: string) {
  return zipLinks(omarchyZip!, OMARCHY_PATH)
    .filter((link) => link.path.startsWith(`${OMARCHY_PATH}/themes/${theme}/backgrounds/`))
    .map((link) => ({
      path: link.target,
      bytes: bytes(resolveBinary(`programs/omarchy/backgrounds/${theme}/${link.target.split("/").pop()}`)!),
      mode: 0o644,
    }));
}

/** A stage of a session: once `after` appears on stdout, `chord` is held
 *  down once, and from then on `keys` and Enter are typed. */
type Step = { after?: string; chord?: number[]; keys: number[] };

/** Boots `launch` (sway on `swayConfig`, or the machine's omarchydesktop)
 *  with `files`, and types the current step's keys and Enter every 3 seconds
 *  until sway ends. Keys reach fuzzel only once sway has mapped its layer
 *  surface and given it the keyboard. */
async function typeUntilSwayEnds(
  swayConfig: string,
  files: { path: string; text: string }[],
  steps: Step[],
  launch: "sway" | "omarchydesktop" = "sway",
) {
  const out = { value: "" };
  const err = { value: "" };
  const encode = (text: string) => new TextEncoder().encode(text);
  const host = new NodeKernelHost({
    rootfsImage: await sessionRootfs("sway", [
      ...zipFiles(omarchyZip!, OMARCHY_PATH),
      ...themeBackgrounds("tokyo-night"),
      ...themeBackgrounds("gruvbox"),
      ...zipFiles(desktopData!, "/usr/share/kandelo"),
      { path: "/bin/bash", bytes: bytes(bashBin!), mode: 0o755 },
      { path: "/usr/bin/omarchydesktop", bytes: bytes(desktopLauncher!), mode: 0o755 },
      { path: "/usr/bin/sway", bytes: new Uint8Array(compositorBytes("sway")), mode: 0o755 },
      { path: "/usr/bin/basuctl", bytes: bytes(basuctlBin!), mode: 0o755 },
      { path: "/usr/bin/dbus-daemon", bytes: bytes(dbusDaemonBin!), mode: 0o755 },
      { path: "/usr/bin/mako", bytes: bytes(makoBin!), mode: 0o755 },
      { path: "/usr/bin/makoctl", bytes: bytes(makoctlBin!), mode: 0o755 },
      { path: "/etc/dbus-1/session.conf", bytes: encode(SESSION_BUS), mode: 0o644 },
      { path: "/etc/passwd", bytes: bytes(PASSWD), mode: 0o644 },
      { path: "/bin/coreutils", bytes: bytes(coreutilsBin!), mode: 0o755 },
      { path: "/usr/bin/busybox", bytes: bytes(busyboxBin!), mode: 0o755 },
      { path: "/usr/bin/cmp", bytes: bytes(cmpBin!), mode: 0o755 },
      { path: "/usr/bin/find", bytes: bytes(findBin!), mode: 0o755 },
      { path: "/usr/bin/fuzzel", bytes: bytes(fuzzelBin!), mode: 0o755 },
      { path: "/usr/bin/gawk", bytes: bytes(gawkBin!), mode: 0o755 },
      { path: "/usr/bin/grep", bytes: bytes(grepBin!), mode: 0o755 },
      { path: "/usr/bin/jq", bytes: bytes(jqBin!), mode: 0o755 },
      { path: "/usr/bin/lua", bytes: bytes(luaBin!), mode: 0o755 },
      { path: "/usr/bin/sed", bytes: bytes(sedBin!), mode: 0o755 },
      { path: "/usr/bin/swaybg", bytes: bytes(swaybgBin!), mode: 0o755 },
      { path: "/usr/bin/swaymsg", bytes: bytes(swaymsgBin!), mode: 0o755 },
      { path: `${FONT_DIR}/Inconsolata-Regular.ttf`, bytes: bytes(INCONSOLATA), mode: 0o644 },
      { path: "/etc/fonts/fonts.conf", bytes: encode(FONTS_CONF), mode: 0o644 },
      { path: "/etc/sway/config", bytes: encode(swayConfig), mode: 0o644 },
      ...files.map((file) => ({ path: file.path, bytes: encode(file.text), mode: 0o644 })),
    ], [
      ...zipLinks(omarchyZip!, OMARCHY_PATH),
      { path: "/bin/sh", target: "bash" },
      { path: "/usr/bin/awk", target: "gawk" },
      { path: "/usr/bin/busctl", target: "basuctl" },
      { path: "/usr/bin/env", target: "/bin/coreutils" },
      ...COREUTILS_NAMES.map((name) => ({ path: `/bin/${name}`, target: "coreutils" })),
      ...["flock", "pgrep", "pkill"].map((name) => ({ path: `/usr/bin/${name}`, target: "busybox" })),
    ]),
    onStdout: (_pid, data) => { out.value += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { err.value += new TextDecoder().decode(data); },
  });
  const env = [
    ...WLROOTS_ENV,
    `PATH=${OMARCHY_PATH}/bin:/usr/bin:/bin`,
    `OMARCHY_PATH=${OMARCHY_PATH}`,
    "HOME=/tmp",
    `SWAYSOCK=${SWAYSOCK}`,
  ];
  const key = (code: number, value: number) => {
    host.injectInputEvent(0, EV_KEY, code, value);
    host.injectInputEvent(0, EV_SYN, SYN_REPORT, 0);
  };
  const press = (code: number) => {
    key(code, 1);
    key(code, 0);
  };

  try {
    await host.init();
    host.setInputCanvasDims(CANVAS_W, CANVAS_H);
    let swayCode: number | null = null;
    const started = launch === "sway"
      ? host.spawn(compositorBytes("sway"), ["sway"], { env })
      : host.spawn(bytes(bashBin!).buffer, ["bash", "-c", DESKTOP_LAUNCH], { env });
    started.then((code) => { swayCode = code; });

    const deadline = Date.now() + 200_000;
    let step = -1;
    while (swayCode === null && Date.now() < deadline) {
      const next = steps[step + 1];
      if (next && out.value.includes(next.after ?? "")) {
        step++;
        next.chord?.forEach((code) => key(code, 1));
        next.chord?.toReversed().forEach((code) => key(code, 0));
        if (next.chord) await new Promise((r) => setTimeout(r, 3000));
      }
      const keys = steps[step]?.keys ?? [];
      for (let i = 0; i < keys.length; i++) press(KEY_BACKSPACE);
      for (const key of keys) press(key);
      press(KEY_ENTER);
      await new Promise((r) => setTimeout(r, 3000));
    }
    return { swayCode, stdout: out.value, dump: `--- stdout ---\n${out.value}\n--- stderr ---\n${err.value}` };
  } finally {
    await host.destroy().catch(() => {});
  }
}

describe("omarchy — Omarchy's menu and themes on sway and fuzzel", () => {
  it(
    "opens the System menu and ends the session from its Logout entry",
    async () => {
      const session = await typeUntilSwayEnds("exec omarchy-menu toggle system\n", [], [{ keys: [KEY_L, KEY_O, KEY_G, KEY_O] }]);

      expect(session.swayCode, `sway did not end from the Logout entry.\n${session.dump}`).toBe(0);
    },
    240_000,
  );

  it(
    "switches to Gruvbox from the theme picker and recolors the bar",
    async () => {
      const session = await typeUntilSwayEnds(
        THEME_CONFIG,
        [{ path: "/etc/sway/theme-report", text: THEME_REPORT }],
        [{ keys: [KEY_G, KEY_R, KEY_U, KEY_V] }],
      );

      expect(session.swayCode, `sway did not end after the theme switch.\n${session.dump}`).toBe(0);
      expect(session.stdout, session.dump).toContain("theme=gruvbox\n");
      expect(session.stdout, session.dump).toContain(`background=${STATE}/theme/backgrounds/1-the-backwater.jpg\n`);
      expect(session.stdout, session.dump).toContain("bar=#282828\n");
      expect(session.stdout, session.dump).toContain("rows=cached\n");
      expect(session.stdout, session.dump).toContain(`swaybg=swaybg -i ${STATE}/theme/backgrounds/1-the-backwater.jpg -m fill \n`);
      expect(session.dump, "swaybg could not read the JPEG background").not.toMatch(/Failed to (load|read) (background )?image/);
    },
    240_000,
  );

  it(
    "binds Omarchy's keys in sway, lists them, and opens the System menu from SUPER + ESCAPE",
    async () => {
      const session = await typeUntilSwayEnds(
        BINDINGS_CONFIG,
        [{ path: "/etc/sway/bindings-report", text: BINDINGS_REPORT }],
        [
          { keys: [KEY_L, KEY_O, KEY_G, KEY_O] },
          { after: "bindings-ready\n", chord: [KEY_LEFTMETA, KEY_ESC], keys: [KEY_L, KEY_O, KEY_G, KEY_O] },
        ],
      );

      expect(session.swayCode, `sway did not end from the System menu's Logout entry.\n${session.dump}`).toBe(0);
      expect(session.stdout, session.dump).toContain("menu: SUPER + ESCAPE → System menu\n");
      expect(session.stdout, session.dump).toContain("menu: SUPER + W → Close window\n");
      expect(session.stdout, session.dump).toContain("menu: SUPER + 1 → Switch to workspace 1\n");
      expect(session.stdout, session.dump).not.toContain("→ Emojis");
      expect(session.stdout, session.dump).toContain(
        "skipped: omarchy-sway-bindings: skipped SUPER + CTRL + E (Emojis): nothing answers omarchy-shell shell toggle omarchy.emojis\n",
      );
    },
    240_000,
  );

  it(
    "sends a notification from Omarchy's script through busctl to mako",
    async () => {
      const session = await typeUntilSwayEnds(
        "exec bash /etc/sway/notification-report\n",
        [{ path: "/etc/sway/notification-report", text: NOTIFICATION_REPORT }],
        [{ keys: [] }],
      );

      expect(session.swayCode, `sway did not end after the notification.\n${session.dump}`).toBe(0);
      expect(session.stdout, session.dump).toContain(
        "id=1\nmako: Notification 1: foo\nmako:   App name: omarchy-action\nmako:   Urgency: critical\n",
      );
    },
    240_000,
  );

  it(
    "shows a loading notification until the theme picker opens, after a preload",
    async () => {
      const session = await typeUntilSwayEnds(
        `include ${STATE}/theme/sway.conf\nexec bash /etc/sway/loading-report\n`,
        [{ path: "/etc/sway/loading-report", text: LOADING_REPORT }],
        [{ keys: [KEY_G, KEY_R, KEY_U, KEY_V] }],
      );

      expect(session.swayCode, `sway did not end after the theme switch.\n${session.dump}`).toBe(0);
      expect(session.stdout, session.dump).toContain("preload=ok\nrows=cached\nshell-preload=ok\n");
      expect(session.stdout, session.dump).toContain("loading=shown\nloading-with-picker=0\n");
      expect(session.stdout, session.dump).toContain("theme=gruvbox\n");
    },
    240_000,
  );

  it(
    "shows a loading notification until the root menu opens",
    async () => {
      // No root entry matches "q", so the helper's Enter picks nothing.
      const session = await typeUntilSwayEnds(
        "exec bash /etc/sway/menu-loading-report\n",
        [{ path: "/etc/sway/menu-loading-report", text: MENU_LOADING_REPORT }],
        [{ keys: [KEY_Q] }],
      );

      expect(session.swayCode, `sway did not end after the menu opened.\n${session.dump}`).toBe(0);
      expect(session.stdout, session.dump).toContain("loading=1\n");
    },
    240_000,
  );

  it(
    "boots the machine's omarchydesktop, switches its theme and ends from SUPER + ESCAPE",
    async () => {
      const session = await typeUntilSwayEnds("", [{ path: THEME_HOOK, text: THEME_HOOK_REPORT }], [
        { after: "SWAY subscribed\n", chord: [KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_SPACE], keys: [KEY_G, KEY_R, KEY_U, KEY_V] },
        { after: "SWAY tick theme=gruvbox", chord: [KEY_LEFTMETA, KEY_ESC], keys: [KEY_L, KEY_O, KEY_G, KEY_O] },
      ], "omarchydesktop");

      expect(session.swayCode, `the desktop did not end from the Logout entry.\n${session.dump}`).toBe(0);
      expect(session.dump, "the launcher reported a failure").not.toContain("omarchydesktop: ");
      expect(session.stdout, session.dump).toContain("SWAY binding exec omarchy-menu toggle theme\n");
      expect(session.stdout, session.dump).toContain("SWAY tick theme=gruvbox bar=#282828\n");
      expect(session.stdout, session.dump).toContain("SWAY binding exec omarchy-menu toggle system\n");
    },
    240_000,
  );
});
