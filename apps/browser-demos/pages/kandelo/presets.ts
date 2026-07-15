import { ABI_VERSION } from "../../../../host/src/generated/abi";

export interface Preset {
  id: string;
  title: string;
  summary: string;
  base: string;
  packages: string[];
  accent: string;
  glyph: string;
  bootCommand: string[];
  estimatedUrlBytes: number;
}

const SHELL_BASE = `kandelo:shell@abi${ABI_VERSION}`;

export const PRESET_LIBRARY: Preset[] = [
  {
    id: "shell",
    title: "Bare shell",
    summary: "Bash, dash, coreutils, and the full utility set from the shell image.",
    base: SHELL_BASE,
    packages: [
      "bash@local",
      "dash@local",
      "coreutils@local",
      "grep@local",
      "sed@local",
      "curl@local",
      "git@local",
      "nano@local",
    ],
    accent: "#dc6529",
    glyph: "sh",
    bootCommand: ["bash", "-l", "-i"],
    estimatedUrlBytes: 312,
  },
  {
    id: "node",
    title: "Node.js",
    summary: "SpiderMonkey-backed Node.js compatibility runtime with npm staged as /usr/bin/node.",
    base: SHELL_BASE,
    packages: ["node@local", "node-vfs@local", "npm@10.9.2", "bash@local", "coreutils@local"],
    accent: "#43853d",
    glyph: "js",
    bootCommand: ["bash", "-l", "-i"],
    estimatedUrlBytes: 812,
  },
  {
    id: "nginx",
    title: "nginx",
    summary: "Static HTTP service supervised by dinit and exposed through the browser bridge.",
    base: SHELL_BASE,
    packages: ["dinit@local", "nginx@local", "bash@local", "coreutils@local"],
    accent: "#3a8f41",
    glyph: "nx",
    bootCommand: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "nginx"],
    estimatedUrlBytes: 756,
  },
  {
    id: "nginx-php",
    title: "nginx + PHP",
    summary: "nginx forwarding through FastCGI to PHP-FPM.",
    base: SHELL_BASE,
    packages: ["dinit@local", "nginx@local", "php-fpm@local", "bash@local", "coreutils@local"],
    accent: "#6b63a6",
    glyph: "php",
    bootCommand: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "nginx"],
    estimatedUrlBytes: 944,
  },
  {
    id: "wordpress-sqlite",
    title: "WordPress SQLite",
    summary: "WordPress on nginx + PHP-FPM with the SQLite database plugin.",
    base: SHELL_BASE,
    packages: [
      "dinit@local",
      "nginx@local",
      "php-fpm@local",
      "wordpress@local",
      "sqlite@local",
      "bash@local",
      "coreutils@local",
    ],
    accent: "#21759b",
    glyph: "wp",
    bootCommand: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "nginx"],
    estimatedUrlBytes: 1284,
  },
  {
    id: "wordpress-mariadb",
    title: "WordPress MariaDB",
    summary: "WordPress on nginx + PHP-FPM with MariaDB.",
    base: SHELL_BASE,
    packages: [
      "dinit@local",
      "nginx@local",
      "php-fpm@local",
      "mariadb@local",
      "wordpress@local",
      "bash@local",
      "coreutils@local",
    ],
    accent: "#5f8f73",
    glyph: "wp+",
    bootCommand: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", "nginx"],
    estimatedUrlBytes: 1442,
  },
  {
    id: "doom",
    title: "fbDOOM",
    summary: "id Software's DOOM rendering directly to /dev/fb0.",
    base: SHELL_BASE,
    packages: ["fbdoom@local", "doom-shareware@local", "bash@local", "coreutils@local"],
    accent: "#b5301c",
    glyph: "D",
    bootCommand: ["/usr/games/fbdoom"],
    estimatedUrlBytes: 1018,
  },
  {
    id: "modeset",
    title: "DRM/KMS modeset",
    summary: "Rotating gradient driven through /dev/dri/card0 + drmModePageFlip onto a host OffscreenCanvas.",
    base: SHELL_BASE,
    packages: ["bash@local", "coreutils@local"],
    accent: "#4f8fd6",
    glyph: "K",
    bootCommand: ["bash", "-l", "-i"],
    estimatedUrlBytes: 612,
  },
  {
    id: "sdl2",
    title: "SDL2 GLSL playground",
    summary: "SDL2 GLSL shader playground: a live-coding editor (left) beside a GLES2 fragment shader rendered on a 1920×1080 /dev/dri/card0 surface (right), auto-recompiling 250 ms after you stop typing. F1/F2 switch between the image and sound shader, Ctrl+L cycles presets, Ctrl+S persists, ESC quits.",
    base: SHELL_BASE,
    packages: ["bash@local", "coreutils@local"],
    accent: "#9c27b0",
    glyph: "S",
    bootCommand: ["bash", "-l", "-i"],
    estimatedUrlBytes: 612,
  },
  {
    id: "wayland",
    title: "Wayland terminal",
    summary: "A real Wayland stack on /dev/dri/card0: wlcompositor (a wl_shm/xdg_shell server driving KMS) composites wlterm — a VT100 terminal built on the in-tree libkwl toolkit — running a forkpty'd dash shell. Type to drive the shell; output renders through the compositor.",
    base: SHELL_BASE,
    packages: ["bash@local", "coreutils@local"],
    accent: "#3a7d7b",
    glyph: "W",
    bootCommand: ["bash", "-l", "-i"],
    estimatedUrlBytes: 612,
  },
  {
    id: "sdl2gl",
    title: "SDL2 on Wayland (GL)",
    summary: "Upstream SDL2's Wayland+GLES2 backend rendering a spinning triangle through wlcompositor: SDL's wl_egl_window becomes a GPU dmabuf buffer, libEGL targets its FBO, and eglSwapBuffers attach+commits it zero-copy to the compositor on /dev/dri/card0. The first third-party GL toolkit driven end to end over the Wayland DRI path.",
    base: SHELL_BASE,
    packages: ["bash@local", "coreutils@local"],
    accent: "#7b3aa0",
    glyph: "G",
    bootCommand: ["bash", "-l", "-i"],
    estimatedUrlBytes: 612,
  },
];
