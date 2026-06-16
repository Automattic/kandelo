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
    title: "DRM/KMS fluid sim",
    summary: "Pavel-style EGL/GLES fluid simulation presented through /dev/dri/card0 page flips.",
    base: SHELL_BASE,
    packages: ["modeset@local", "bash@local", "coreutils@local"],
    accent: "#4f8fd6",
    glyph: "K",
    bootCommand: ["/usr/local/bin/modeset"],
    estimatedUrlBytes: 612,
  },
];
