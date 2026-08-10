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
 * (Tokyo Night, Catppuccin Mocha, Gruvbox); the keys are ours.
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
};

/**
 * The themes. Each is one palette file read by the compositor (border, gaps,
 * wallpaper) and by the shell clients (bar, foreground, accent) — one file,
 * both sides, which is what makes a switch atomic across the desktop.
 */
export const OMARCHY_THEMES: Record<string, string> = {
  "tokyo-night": `# Tokyo Night
border_active = 0x7aa2f7
wallpaper_top = 0x1a1b26
wallpaper_bottom = 0x24283b
bar = 0x16161e
foreground = 0xc0caf5
muted = 0x565f89
accent = 0x7aa2f7
occupied = 0x292e42
background = 0x1a1b26
gaps_in = 8
gaps_out = 12
`,
  "catppuccin": `# Catppuccin Mocha
border_active = 0xcba6f7
wallpaper_top = 0x1e1e2e
wallpaper_bottom = 0x313244
bar = 0x181825
foreground = 0xcdd6f4
muted = 0x6c7086
accent = 0xcba6f7
occupied = 0x313244
background = 0x1e1e2e
gaps_in = 10
gaps_out = 16
`,
  "gruvbox": `# Gruvbox Dark
border_active = 0xd79921
wallpaper_top = 0x282828
wallpaper_bottom = 0x3c3836
bar = 0x1d2021
foreground = 0xebdbb2
muted = 0x928374
accent = 0xd79921
occupied = 0x3c3836
background = 0x282828
gaps_in = 6
gaps_out = 8
`,
};
