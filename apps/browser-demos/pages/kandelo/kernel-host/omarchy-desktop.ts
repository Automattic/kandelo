/**
 * The data half of the /?demo=omarchy desktop: the compositor config, the
 * launcher's app registry, and the themes.
 *
 * Omarchy is not a program — it is an opinionated set of files layered over
 * Hyprland: keybindings, a bar, a launcher, and a theme directory switched by
 * re-linking one entry. This module is that layer for Kandelo: every file here
 * lands in the VFS at boot, and the compositor + Waybar + klauncher read them
 * at runtime exactly as they would read an installed desktop.
 *
 * Palettes are the well-known upstream colour schemes Omarchy ships
 * (Tokyo Night, Catppuccin Mocha, Gruvbox, Nord, Everforest, Rosé Pine); the
 * keys are ours. Each theme also carries its wallpaper — the real Omarchy
 * background image plus an aurora fallback spec. The page renders it to raw
 * pixels at staging time because nothing in the compositor decodes PNG/JPEG —
 * it reads the KWLP raw format and crops and scales it to the output.
 */

import tokyoNightWallpaperUrl from "../assets/tokyo-night-sunset-lake.jpg";
import catppuccinWallpaperUrl from "../assets/catppuccin-totoro.jpg";
import gruvboxWallpaperUrl from "../assets/gruvbox-the-backwater.jpg";
import nordWallpaperUrl from "../assets/nord-black-moon.jpg";
import everforestWallpaperUrl from "../assets/everforest-tree-tops.jpg";
import rosePineWallpaperUrl from "../assets/rose-pine-funky-shapes.jpg";

/** Where the desktop's files live in the VFS. */
export const OMARCHY_CONF_PATH = "/etc/kandelo/wlcompositor.conf";
export const OMARCHY_THEME_DIR = "/usr/share/kandelo/themes";
export const OMARCHY_APPS_DIR = "/usr/share/kandelo/apps";
// /home/maker is a scratch mount (host/src/vfs/default-mounts.ts), so image
// bytes under it are shadowed at boot. The desktop's read-only configs are
// image bytes under /usr/share/kandelo, and the one file the theme hook
// rewrites — Waybar's stylesheet — lives on the /tmp scratch mount, seeded
// from its image copy by the bash gate that starts the bar.
export const OMARCHY_WAYBAR_CONFIG_PATH = "/usr/share/kandelo/waybar/config.jsonc";
export const OMARCHY_WAYBAR_STYLE_SEED_PATH = "/usr/share/kandelo/waybar/style.css";
export const OMARCHY_WAYBAR_STYLE_PATH = "/tmp/waybar-style.css";
export const OMARCHY_MAKO_CONFIG_PATH = "/usr/share/kandelo/mako/config";

/**
 * The compositor config. SUPER is what real Hyprland (and Omarchy) binds, but
 * a browser reserves it for the OS (Cmd/Win), so every action is mirrored on
 * CTRL — the modifier that actually reaches the page. The compositor grabs a
 * bound combo before the focused client, so CTRL+W here shadows a terminal's
 * werase (see docs/browser-support.md).
 */
export const OMARCHY_WLCOMPOSITOR_CONF = `# Kandelo wlcompositor — the Omarchy-shaped desktop.
theme = tokyo-night
notify = /usr/bin/bash /usr/local/bin/omarchy-theme-changed

# Applications.
bind = SUPER, Return, exec, /usr/local/bin/wlterm
bind = CTRL, Return, exec, /usr/local/bin/wlterm
bind = SUPER, K, exec, /usr/local/bin/wlclock
bind = CTRL, K, exec, /usr/local/bin/wlclock
bind = SUPER, P, exec, /usr/local/bin/wlpaint
bind = CTRL, P, exec, /usr/local/bin/wlpaint

# The launcher, on Omarchy's SUPER+Space.
bind = SUPER, space, exec, /usr/local/bin/klauncher
bind = CTRL, space, exec, /usr/local/bin/klauncher

# The Omarchy menu, on Omarchy's SUPER+ALT+Space.
bind = SUPER ALT, space, exec, /usr/local/bin/klauncher --menu
bind = CTRL ALT, space, exec, /usr/local/bin/klauncher --menu

# Window management.
bind = SUPER, W, killactive
bind = CTRL, W, killactive
bind = SUPER, J, cyclenext
bind = CTRL, J, cyclenext
bind = SUPER SHIFT, J, cycleprev
bind = CTRL SHIFT, J, cycleprev

# Theme cycling, on Omarchy's SUPER+CTRL+SHIFT+Space.
bind = SUPER CTRL SHIFT, space, theme, next
bind = CTRL SHIFT, space, theme, next

# Workspaces.
bind = SUPER, 1, workspace, 1
bind = SUPER, 2, workspace, 2
bind = SUPER, 3, workspace, 3
bind = SUPER, 4, workspace, 4
bind = SUPER, 5, workspace, 5
bind = SUPER, 6, workspace, 6
bind = SUPER, 7, workspace, 7
bind = SUPER, 8, workspace, 8
bind = SUPER, 9, workspace, 9
bind = CTRL, 1, workspace, 1
bind = CTRL, 2, workspace, 2
bind = CTRL, 3, workspace, 3
bind = CTRL, 4, workspace, 4
bind = CTRL, 5, workspace, 5
bind = CTRL, 6, workspace, 6
bind = CTRL, 7, workspace, 7
bind = CTRL, 8, workspace, 8
bind = CTRL, 9, workspace, 9
bind = SUPER SHIFT, 1, movetoworkspace, 1
bind = SUPER SHIFT, 2, movetoworkspace, 2
bind = SUPER SHIFT, 3, movetoworkspace, 3
bind = CTRL SHIFT, 1, movetoworkspace, 1
bind = CTRL SHIFT, 2, movetoworkspace, 2
bind = CTRL SHIFT, 3, movetoworkspace, 3
`;

/**
 * The launcher registry: one file per application. A package installs itself
 * into the launcher by dropping a file here, which is why this is a directory
 * and not a list inside the launcher.
 */
export const OMARCHY_APPS: Record<string, string> = {
  "terminal.conf": "name = Terminal\nexec = /usr/local/bin/wlterm\n",
  "clock.conf": "name = Clock\nexec = /usr/local/bin/wlclock\n",
  "paint.conf": "name = Paint\nexec = /usr/local/bin/wlpaint\n",
  "vim.conf": "name = Vim\nexec = /usr/local/bin/wlterm /usr/bin/vim\n",
  "nethack.conf": "name = NetHack\nexec = /usr/local/bin/wlterm /usr/bin/nethack\n",
  "nano.conf": "name = Nano\nexec = /usr/local/bin/wlterm /usr/bin/nano\n",
  "bash.conf": "name = Bash\nexec = /usr/local/bin/wlterm /usr/bin/bash -i\n",
  "foot.conf":
    "name = Foot\nexec = /usr/local/bin/foot --term=vt100 --override=main.workers=0 /usr/bin/bash -i\n",
};

/**
 * The fontconfig configuration foot reads at startup. The demo stages one
 * font (Inconsolata) under /usr/share/fonts and aliases the generic
 * "monospace" family to it, so foot's default font pattern resolves without
 * a per-user configuration.
 */
export const OMARCHY_FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/usr/share/fonts</dir>
  <cachedir>/tmp/fontconfig</cachedir>
  <alias>
    <family>monospace</family>
    <prefer><family>Inconsolata</family></prefer>
  </alias>
</fontconfig>
`;

/** The session bus socket every desktop process shares: dbus-daemon listens
 * on it, mako owns org.freedesktop.Notifications on it, and notify-send
 * (spawned by the compositor's `notify =` hook, or from any terminal) calls
 * Notify there. */
export const OMARCHY_BUS_SOCKET = "/tmp/dbus-session.socket";

/**
 * The dbus-daemon session config: EXTERNAL auth (SO_PEERCRED) with an
 * allow-all policy — the single-user demo bus, not a hardened system bus.
 */
export const OMARCHY_DBUS_SESSION_CONF = `<busconfig>
  <type>session</type>
  <listen>unix:path=${OMARCHY_BUS_SOCKET}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`;

/**
 * mako's config. Upstream mako keeps a notification until dismissed
 * (default-timeout=0); the demo's toasts dismiss themselves like Omarchy's.
 * The colours are the tokyo-night palette the desktop boots with — mako
 * reads its config once at startup, so they persist across theme switches.
 */
export const OMARCHY_MAKO_CONFIG = `default-timeout=5000
background-color=#1a1b26
text-color=#c0caf5
border-color=#7aa2f7
`;

/**
 * Waybar config, translated from Omarchy's (config.jsonc): same top bar
 * with workspaces left and the clock centered. The module lineup keeps
 * only what this kernel backs — no /proc/stat, /sys battery, libnl
 * network, or pulseaudio — and the Nerd Font glyphs become plain text
 * (the demo stages Inconsolata only). The hyprland modules speak
 * Hyprland IPC against wlcompositor's socket pair.
 */
export const OMARCHY_WAYBAR_CONFIG = `{
  "layer": "top",
  "position": "top",
  "spacing": 0,
  "height": 26,
  "modules-left": ["hyprland/workspaces"],
  "modules-center": ["clock"],
  "modules-right": ["hyprland/window"],
  "hyprland/workspaces": {
    "on-click": "activate",
    "format": "{name}",
    "persistent-workspaces": { "1": [], "2": [], "3": [], "4": [], "5": [] }
  },
  "hyprland/window": { "format": "{title}", "max-length": 60 },
  "clock": { "format": "{:%H:%M:%S}", "interval": 1, "tooltip": false }
}
`;

/**
 * Waybar stylesheet: Omarchy's style.css shape over one palette. The theme
 * hook renders the same template from the switched-to theme.conf, so the two
 * paths — the file staged at boot and the file rewritten on a switch — cannot
 * drift apart.
 */
const waybarStyle = (c: Record<string, string>) => `* {
  font-family: monospace;
  font-size: 13px;
  min-height: 0;
}
window#waybar {
  background: ${c.bar};
  color: ${c.foreground};
}
#workspaces button {
  padding: 0 6px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: ${c.muted};
}
#workspaces button.active {
  color: ${c.accent};
}
#workspaces button.empty {
  color: ${c.occupied};
}
#window,
#clock {
  padding: 0 8px;
  color: ${c.foreground};
}
`;

/** The stylesheet staged at boot, on the theme the compositor config names. */
export const OMARCHY_WAYBAR_STYLE = waybarStyle({
  bar: "#16161e",
  foreground: "#c0caf5",
  muted: "#565f89",
  accent: "#7aa2f7",
  occupied: "#292e42",
});

/**
 * The compositor's `notify =` hook, which is where Omarchy puts the rest of a
 * theme switch: its omarchy-theme-set writes the bar's stylesheet from the new
 * palette and sends Waybar SIGUSR2, then notifies. The compositor repaints its
 * own half (borders, gaps, wallpaper) and appends `Theme <name>` to this
 * command, so `$2` is the theme that just became current.
 *
 * Bash builtins only, plus the final exec: a fork from the compositor's hook
 * would cost a whole process image for a file write. `/proc/<pid>/cmdline`
 * stands in for pkill, which this image does not carry.
 *
 * The signal reaches Waybar while its threads sit in `poll()` and `read()`:
 * the host ends the park with EINTR and the glue re-issues the syscall, so the
 * handler runs and the bar reloads the new stylesheet in place. The whole
 * switch is live.
 */
export const OMARCHY_THEME_HOOK = `#!/usr/bin/bash
theme=$2
conf=\${WLC_THEME_DIR:-${OMARCHY_THEME_DIR}}/$theme/theme.conf
css=${OMARCHY_WAYBAR_STYLE_PATH}

if [ -r "$conf" ]; then
  while read -r key sep val; do
    case $key in
      bar|foreground|muted|accent|occupied) printf -v "c_$key" '#%s' "\${val#0x}" ;;
    esac
  done < "$conf"

  printf '%s' "${waybarStyle({
    bar: "$c_bar",
    foreground: "$c_foreground",
    muted: "$c_muted",
    accent: "$c_accent",
    occupied: "$c_occupied",
  })}" > "$css"

  # /proc/<pid>/cmdline ends without a newline, so read reports EOF even
  # though it filled cmd — its status says nothing here.
  for d in /proc/[0-9]*; do
    cmd=
    read -r cmd < "$d/cmdline"
    case $cmd in
      waybar*)
        kill -USR2 "\${d#/proc/}"
        printf 'THEME_HOOK theme=%s bar=%s bar_pid=%s\\n' \\
          "$theme" "$c_bar" "\${d#/proc/}"
        ;;
    esac
  done
fi

exec /usr/local/bin/notify-send "$@"
`;

/**
 * One radial glow of a wallpaper: center and radius as fractions of the
 * output, colour as #rrggbb, alpha at the center fading to zero at the edge.
 */
export type WallpaperGlow = [x: number, y: number, r: number, color: string, alpha: number];

export interface OmarchyTheme {
  /** theme.conf body: one palette file read by the compositor (border, gaps,
   * wallpaper) and by the shell clients (bar, foreground, accent) — one file,
   * both sides, which is what makes a switch atomic across the desktop. */
  conf: string;
  /** The theme's wallpaper: `image` is the bundled URL of its real Omarchy
   * background, rendered by renderImageWallpaperKwlp; the aurora spec is the
   * fallback rendered by renderWallpaperKwlp when the fetch or decode fails. */
  wallpaper: { base: string; glows: WallpaperGlow[]; image?: string };
}

export const OMARCHY_THEMES: Record<string, OmarchyTheme> = {
  "tokyo-night": {
    conf: `# Tokyo Night
border_active = 0x7aa2f7
wallpaper_top = 0x1a1b26
wallpaper_bottom = 0x24283b
wallpaper = background.kwlp
bar = 0x16161e
foreground = 0xc0caf5
muted = 0x565f89
accent = 0x7aa2f7
occupied = 0x292e42
background = 0x1a1b26
gaps_in = 8
gaps_out = 12
`,
    wallpaper: {
      base: "#16161e",
      image: tokyoNightWallpaperUrl,
      glows: [
        [0.22, 0.85, 0.75, "#7aa2f7", 0.32],
        [0.85, 0.15, 0.65, "#bb9af7", 0.26],
        [0.62, 0.72, 0.5, "#7dcfff", 0.18],
        [0.1, 0.1, 0.45, "#3d59a1", 0.3],
      ],
    },
  },
  "catppuccin": {
    conf: `# Catppuccin Mocha
border_active = 0xcba6f7
wallpaper_top = 0x1e1e2e
wallpaper_bottom = 0x313244
wallpaper = background.kwlp
bar = 0x181825
foreground = 0xcdd6f4
muted = 0x6c7086
accent = 0xcba6f7
occupied = 0x313244
background = 0x1e1e2e
gaps_in = 10
gaps_out = 16
`,
    wallpaper: {
      base: "#181825",
      image: catppuccinWallpaperUrl,
      glows: [
        [0.8, 0.8, 0.7, "#cba6f7", 0.3],
        [0.15, 0.2, 0.6, "#f5c2e7", 0.22],
        [0.5, 0.45, 0.5, "#89b4fa", 0.18],
        [0.9, 0.1, 0.4, "#f38ba8", 0.16],
      ],
    },
  },
  "gruvbox": {
    conf: `# Gruvbox Dark
border_active = 0xd79921
wallpaper_top = 0x282828
wallpaper_bottom = 0x3c3836
wallpaper = background.kwlp
bar = 0x1d2021
foreground = 0xebdbb2
muted = 0x928374
accent = 0xd79921
occupied = 0x3c3836
background = 0x282828
gaps_in = 6
gaps_out = 8
`,
    wallpaper: {
      base: "#1d2021",
      image: gruvboxWallpaperUrl,
      glows: [
        [0.5, 0.95, 0.8, "#d79921", 0.28],
        [0.12, 0.25, 0.55, "#cc241d", 0.14],
        [0.88, 0.3, 0.5, "#98971a", 0.16],
        [0.7, 0.6, 0.45, "#d65d0e", 0.18],
      ],
    },
  },
  "nord": {
    conf: `# Nord
border_active = 0x88c0d0
wallpaper_top = 0x2e3440
wallpaper_bottom = 0x3b4252
wallpaper = background.kwlp
bar = 0x272c36
foreground = 0xd8dee9
muted = 0x4c566a
accent = 0x88c0d0
occupied = 0x3b4252
background = 0x2e3440
gaps_in = 8
gaps_out = 12
`,
    wallpaper: {
      base: "#272c36",
      image: nordWallpaperUrl,
      glows: [
        [0.3, 0.1, 0.7, "#88c0d0", 0.24],
        [0.85, 0.75, 0.65, "#5e81ac", 0.3],
        [0.1, 0.8, 0.5, "#b48ead", 0.16],
        [0.6, 0.4, 0.45, "#81a1c1", 0.18],
      ],
    },
  },
  "everforest": {
    conf: `# Everforest Dark
border_active = 0xa7c080
wallpaper_top = 0x2d353b
wallpaper_bottom = 0x3d484d
wallpaper = background.kwlp
bar = 0x232a2e
foreground = 0xd3c6aa
muted = 0x859289
accent = 0xa7c080
occupied = 0x3d484d
background = 0x2d353b
gaps_in = 8
gaps_out = 12
`,
    wallpaper: {
      base: "#232a2e",
      image: everforestWallpaperUrl,
      glows: [
        [0.2, 0.9, 0.75, "#a7c080", 0.24],
        [0.8, 0.2, 0.6, "#7fbbb3", 0.22],
        [0.55, 0.6, 0.5, "#dbbc7f", 0.14],
        [0.05, 0.15, 0.45, "#425047", 0.4],
      ],
    },
  },
  "rose-pine": {
    conf: `# Rosé Pine
border_active = 0xebbcba
wallpaper_top = 0x191724
wallpaper_bottom = 0x26233a
wallpaper = background.kwlp
bar = 0x12101a
foreground = 0xe0def4
muted = 0x6e6a86
accent = 0xebbcba
occupied = 0x26233a
background = 0x191724
gaps_in = 10
gaps_out = 14
`,
    wallpaper: {
      base: "#12101a",
      image: rosePineWallpaperUrl,
      glows: [
        [0.75, 0.85, 0.7, "#ebbcba", 0.24],
        [0.2, 0.15, 0.6, "#c4a7e7", 0.22],
        [0.5, 0.55, 0.5, "#31748f", 0.2],
        [0.95, 0.25, 0.4, "#eb6f92", 0.12],
      ],
    },
  },
};

function hexToRgba(hex: string, alpha: number): string {
  const v = parseInt(hex.slice(1), 16);
  return `rgba(${(v >> 16) & 0xff}, ${(v >> 8) & 0xff}, ${v & 0xff}, ${alpha})`;
}

/**
 * Render a theme's aurora wallpaper to KWLP raw pixels: "KWLP", u32le width,
 * u32le height, then width*height u32le XRGB pixels. Rendered smaller than the
 * output — the compositor bilinear-upscales, and the content is soft
 * gradients, so the stretch is invisible while the staged file stays ~2 MB.
 */
export function renderWallpaperKwlp(
  theme: OmarchyTheme,
  w = 960,
  h = 540,
): Uint8Array {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = theme.wallpaper.base;
  ctx.fillRect(0, 0, w, h);
  for (const [fx, fy, fr, color, alpha] of theme.wallpaper.glows) {
    const grad = ctx.createRadialGradient(
      fx * w, fy * h, 0, fx * w, fy * h, fr * w);
    grad.addColorStop(0, hexToRgba(color, alpha));
    grad.addColorStop(1, hexToRgba(color, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  return encodeKwlp(ctx, w, h);
}

/** Per-axis ceiling on a staged wallpaper. Six themes are staged eagerly and
 *  each costs width x height x 4 bytes of VFS, so an oversized asset would be
 *  paid for six times over. It matches the connector mode's own width clamp,
 *  above which no pane can ask for the pixels anyway. Every bundled asset is
 *  under it and passes through at its native size. */
const MAX_WALLPAPER_PX = 3840;

/**
 * Render a theme's real background image to KWLP raw pixels at the source's
 * own resolution, capped by MAX_WALLPAPER_PX per axis.
 *
 * The staged size cannot follow the mode. The image is baked into the VFS at
 * compose time and the kernel owns the VFS from boot, while the mode is only
 * decided once the pane's layout settles — and the pane's own box moves while
 * it does. So the page stages every pixel the source has and the compositor
 * cover-crops to whatever mode it ends up with: sharp on a HiDPI pane, and
 * undistorted at any aspect. Staging past the source would cost four times
 * the bytes for pixels the source cannot supply.
 *
 * Returns null when the fetch or decode fails so the caller can fall back to
 * renderWallpaperKwlp.
 */
export async function renderImageWallpaperKwlp(
  url: string,
): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    const fit = Math.min(1,
      MAX_WALLPAPER_PX / bitmap.width, MAX_WALLPAPER_PX / bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * fit));
    const h = Math.max(1, Math.round(bitmap.height * fit));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return encodeKwlp(ctx, w, h);
  } catch {
    return null;
  }
}

function encodeKwlp(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
): Uint8Array {
  const img = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(12 + w * h * 4);
  out.set([0x4b, 0x57, 0x4c, 0x50]);   // "KWLP"
  const view = new DataView(out.buffer);
  view.setUint32(4, w, true);
  view.setUint32(8, h, true);
  for (let i = 0; i < w * h; i++) {
    out[12 + i * 4] = img[i * 4 + 2];
    out[12 + i * 4 + 1] = img[i * 4 + 1];
    out[12 + i * 4 + 2] = img[i * 4];
    out[12 + i * 4 + 3] = 0xff;
  }
  return out;
}
