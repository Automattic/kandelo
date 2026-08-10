/**
 * The data half of the /?demo=omarchy desktop: the compositor config, the
 * launcher's app registry, and the themes.
 *
 * Omarchy is not a program — it is an opinionated set of files layered over
 * Hyprland: keybindings, a bar, a launcher, and a theme directory switched by
 * re-linking one entry. This module is that layer for Kandelo: every file here
 * lands in the VFS at boot, and the compositor + kbar + klauncher read them at
 * runtime exactly as they would read an installed desktop.
 *
 * Palettes are the well-known upstream colour schemes Omarchy ships
 * (Tokyo Night, Catppuccin Mocha, Gruvbox, Nord, Everforest, Rosé Pine); the
 * keys are ours. Each theme also carries a wallpaper spec: the page renders it
 * to raw pixels at staging time (renderWallpaperKwlp) because nothing in the
 * compositor decodes PNG/JPEG — it reads the KWLP raw format and scales it to
 * the output.
 */

/** Where the desktop's files live in the VFS. */
export const OMARCHY_CONF_PATH = "/etc/kandelo/wlcompositor.conf";
export const OMARCHY_THEME_DIR = "/usr/share/kandelo/themes";
export const OMARCHY_APPS_DIR = "/usr/share/kandelo/apps";

/**
 * The compositor config. SUPER is what real Hyprland (and Omarchy) binds, but
 * a browser reserves it for the OS (Cmd/Win), so every action is mirrored on
 * CTRL — the modifier that actually reaches the page. The compositor grabs a
 * bound combo before the focused client, so CTRL+W here shadows a terminal's
 * werase (see docs/browser-support.md).
 */
export const OMARCHY_WLCOMPOSITOR_CONF = `# Kandelo wlcompositor — the Omarchy-shaped desktop.
theme = tokyo-night

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
};

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
  /** Aurora wallpaper spec rendered by renderWallpaperKwlp. */
  wallpaper: { base: string; glows: WallpaperGlow[] };
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
