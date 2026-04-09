# Init System for Browser Demos

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every daemon-based browser demo gets a declarative init system reading `/etc/init.d/` config from the VFS, plus a collapsible shell terminal panel.

**Architecture:** A host-side TypeScript `SystemInit` class reads service descriptors from `/etc/init.d/` in the VFS, orchestrates daemon startup via `BrowserKernel.spawn()`, and boots an interactive shell with PTY as the final service. Each demo page becomes: populate VFS (binaries as lazy files, configs, init descriptors) then call `init.boot()`. A shared `TerminalPanel` component provides the collapsible xterm.js UI.

**Tech Stack:** TypeScript, xterm.js, existing BrowserKernel/PtyTerminal/MemoryFileSystem APIs.

---

## Task 1: Service Descriptor Parser

**Files:**
- Create: `examples/browser/lib/init/service-descriptor.ts`
- Create: `examples/browser/lib/init/parse-init.ts`
- Test: `host/test/browser-init-parser.test.ts`

### Step 1: Write the failing test

```typescript
// host/test/browser-init-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseServiceDescriptor, type ServiceDescriptor } from "../../examples/browser/lib/init/service-descriptor";

describe("parseServiceDescriptor", () => {
  it("parses a daemon service", () => {
    const content = [
      "type=daemon",
      "command=/usr/sbin/nginx -p /etc/nginx -c nginx.conf",
      "ready=port:8080",
      "bridge=8080",
    ].join("\n");
    const svc = parseServiceDescriptor("20-nginx", content);
    expect(svc.name).toBe("nginx");
    expect(svc.order).toBe(20);
    expect(svc.type).toBe("daemon");
    expect(svc.command).toEqual(["/usr/sbin/nginx", "-p", "/etc/nginx", "-c", "nginx.conf"]);
    expect(svc.ready).toEqual({ kind: "port", port: 8080 });
    expect(svc.bridge).toBe(8080);
  });

  it("parses an interactive service", () => {
    const content = [
      "type=interactive",
      "command=/bin/dash -i",
      "env=TERM=xterm-256color PS1=$ HOME=/root PATH=/usr/local/bin:/usr/bin:/bin",
      "pty=true",
    ].join("\n");
    const svc = parseServiceDescriptor("99-shell", content);
    expect(svc.name).toBe("shell");
    expect(svc.order).toBe(99);
    expect(svc.type).toBe("interactive");
    expect(svc.pty).toBe(true);
    expect(svc.env).toEqual(["TERM=xterm-256color", "PS1=$", "HOME=/root", "PATH=/usr/local/bin:/usr/bin:/bin"]);
  });

  it("parses a oneshot with stdin and depends", () => {
    const content = [
      "type=oneshot",
      "command=/usr/sbin/mariadbd --bootstrap",
      "stdin=/etc/mariadb/bootstrap.sql",
      "ready=exit",
      "depends=none",
    ].join("\n");
    const svc = parseServiceDescriptor("05-mariadb-bootstrap", content);
    expect(svc.name).toBe("mariadb-bootstrap");
    expect(svc.type).toBe("oneshot");
    expect(svc.stdin).toBe("/etc/mariadb/bootstrap.sql");
    expect(svc.ready).toEqual({ kind: "exit" });
  });

  it("parses delay readiness", () => {
    const content = [
      "type=daemon",
      "command=/usr/sbin/php-fpm --nodaemonize",
      "ready=delay:3000",
    ].join("\n");
    const svc = parseServiceDescriptor("10-php-fpm", content);
    expect(svc.ready).toEqual({ kind: "delay", ms: 3000 });
  });

  it("skips comments and blank lines", () => {
    const content = [
      "# This is a comment",
      "",
      "type=daemon",
      "command=/usr/sbin/nginx",
    ].join("\n");
    const svc = parseServiceDescriptor("20-nginx", content);
    expect(svc.type).toBe("daemon");
  });

  it("extracts name and order from filename", () => {
    expect(parseServiceDescriptor("05-db-init", "type=oneshot\ncommand=/bin/true").name).toBe("db-init");
    expect(parseServiceDescriptor("05-db-init", "type=oneshot\ncommand=/bin/true").order).toBe(5);
    expect(parseServiceDescriptor("myservice", "type=daemon\ncommand=/bin/true").name).toBe("myservice");
    expect(parseServiceDescriptor("myservice", "type=daemon\ncommand=/bin/true").order).toBe(50);
  });
});
```

### Step 2: Run test to verify it fails

Run: `cd host && npx vitest run test/browser-init-parser.test.ts`
Expected: FAIL — modules don't exist yet.

### Step 3: Write the ServiceDescriptor type

```typescript
// examples/browser/lib/init/service-descriptor.ts

export type ReadyCondition =
  | { kind: "port"; port: number }
  | { kind: "delay"; ms: number }
  | { kind: "exit" }
  | { kind: "stdin-consumed" };

export interface ServiceDescriptor {
  /** Service name derived from filename (e.g., "nginx" from "20-nginx") */
  name: string;
  /** Numeric ordering from filename prefix (default 50) */
  order: number;
  /** Service lifecycle type */
  type: "daemon" | "oneshot" | "interactive";
  /** Argv array: binary path + arguments */
  command: string[];
  /** Environment variables (KEY=VALUE strings) */
  env?: string[];
  /** Working directory */
  cwd?: string;
  /** When is this service considered ready? */
  ready?: ReadyCondition;
  /** Services that must be ready before this one starts */
  depends?: string[];
  /** HTTP bridge port (registers service worker + sends bridge port) */
  bridge?: number;
  /** Allocate PTY for this process (for interactive type) */
  pty?: boolean;
  /** VFS path to file whose contents become stdin */
  stdin?: string;
}

/**
 * Parse a service descriptor from an /etc/init.d/ file.
 *
 * Format: key=value lines. Comments (#) and blank lines are skipped.
 * Filename format: [NN-]name where NN is the numeric order (default 50).
 */
export function parseServiceDescriptor(filename: string, content: string): ServiceDescriptor {
  // Extract order and name from filename
  const match = filename.match(/^(\d+)-(.+)$/);
  const order = match ? parseInt(match[1], 10) : 50;
  const name = match ? match[2] : filename;

  const fields = new Map<string, string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    fields.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }

  const type = (fields.get("type") ?? "daemon") as ServiceDescriptor["type"];
  const commandStr = fields.get("command") ?? "/bin/true";
  const command = splitCommand(commandStr);

  const svc: ServiceDescriptor = { name, order, type, command };

  const envStr = fields.get("env");
  if (envStr) svc.env = envStr.split(" ").filter(Boolean);

  if (fields.has("cwd")) svc.cwd = fields.get("cwd");

  const readyStr = fields.get("ready");
  if (readyStr) {
    if (readyStr === "exit") {
      svc.ready = { kind: "exit" };
    } else if (readyStr === "stdin-consumed") {
      svc.ready = { kind: "stdin-consumed" };
    } else if (readyStr.startsWith("port:")) {
      svc.ready = { kind: "port", port: parseInt(readyStr.slice(5), 10) };
    } else if (readyStr.startsWith("delay:")) {
      svc.ready = { kind: "delay", ms: parseInt(readyStr.slice(6), 10) };
    }
  }

  const dependsStr = fields.get("depends");
  if (dependsStr && dependsStr !== "none") {
    svc.depends = dependsStr.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const bridgeStr = fields.get("bridge");
  if (bridgeStr) svc.bridge = parseInt(bridgeStr, 10);

  if (fields.get("pty") === "true") svc.pty = true;

  if (fields.has("stdin")) svc.stdin = fields.get("stdin");

  return svc;
}

/** Split a command string into argv, respecting double-quoted segments. */
function splitCommand(cmd: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of cmd) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === " " && !inQuote) {
      if (current) args.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}
```

### Step 4: Run test to verify it passes

Run: `cd host && npx vitest run test/browser-init-parser.test.ts`
Expected: PASS — all 6 tests green.

### Step 5: Commit

```bash
git add examples/browser/lib/init/service-descriptor.ts host/test/browser-init-parser.test.ts
git commit -m "feat(browser): add /etc/init.d/ service descriptor parser"
```

---

## Task 2: TerminalPanel UI Component

**Files:**
- Create: `examples/browser/lib/terminal-panel.ts`
- Create: `examples/browser/lib/terminal-panel.css`

### Step 1: Write the CSS

```css
/* examples/browser/lib/terminal-panel.css */
.terminal-panel {
  display: flex;
  flex-direction: column;
  border-top: 1px solid #333;
  background: #1e1e1e;
  min-height: 32px;
}

.terminal-panel-bar {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  cursor: pointer;
  user-select: none;
  color: #aaa;
  font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
  font-size: 12px;
  gap: 8px;
  background: #252525;
  border-bottom: 1px solid #333;
}

.terminal-panel-bar:hover {
  background: #2a2a2a;
}

.terminal-panel-toggle {
  font-size: 10px;
  transition: transform 0.15s;
}

.terminal-panel.expanded .terminal-panel-toggle {
  transform: rotate(90deg);
}

.terminal-panel-status {
  color: #666;
  font-size: 11px;
}

.terminal-panel-body {
  flex: 1;
  display: none;
  overflow: hidden;
}

.terminal-panel.expanded .terminal-panel-body {
  display: block;
}
```

### Step 2: Write the TerminalPanel component

```typescript
// examples/browser/lib/terminal-panel.ts
import "./terminal-panel.css";

export class TerminalPanel {
  private panel: HTMLDivElement;
  private bar: HTMLDivElement;
  private body: HTMLDivElement;
  private statusEl: HTMLSpanElement;
  private _expanded = false;
  private onExpandCallbacks: Array<() => void> = [];

  constructor(container: HTMLElement) {
    this.panel = document.createElement("div");
    this.panel.className = "terminal-panel";

    this.bar = document.createElement("div");
    this.bar.className = "terminal-panel-bar";
    this.bar.innerHTML = `<span class="terminal-panel-toggle">\u25B6</span><span>Terminal</span>`;
    this.statusEl = document.createElement("span");
    this.statusEl.className = "terminal-panel-status";
    this.bar.appendChild(this.statusEl);
    this.bar.addEventListener("click", () => this.toggle());

    this.body = document.createElement("div");
    this.body.className = "terminal-panel-body";

    this.panel.appendChild(this.bar);
    this.panel.appendChild(this.body);
    container.appendChild(this.panel);
  }

  /** The container element where PtyTerminal should mount xterm.js */
  getTerminalContainer(): HTMLElement {
    return this.body;
  }

  get expanded(): boolean {
    return this._expanded;
  }

  expand(): void {
    if (this._expanded) return;
    this._expanded = true;
    this.panel.classList.add("expanded");
    for (const cb of this.onExpandCallbacks) cb();
  }

  collapse(): void {
    if (!this._expanded) return;
    this._expanded = false;
    this.panel.classList.remove("expanded");
  }

  toggle(): void {
    if (this._expanded) this.collapse();
    else this.expand();
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  /** Register callback for when panel expands (useful for xterm.js fit) */
  onExpand(cb: () => void): void {
    this.onExpandCallbacks.push(cb);
  }

  dispose(): void {
    this.panel.remove();
    this.onExpandCallbacks.length = 0;
  }
}
```

### Step 3: Verify it builds

Run: `cd examples/browser && npx vite build --mode development 2>&1 | head -20`
Expected: No import errors for new files (they aren't imported yet, so build should be unaffected).

### Step 4: Commit

```bash
git add examples/browser/lib/terminal-panel.ts examples/browser/lib/terminal-panel.css
git commit -m "feat(browser): add collapsible TerminalPanel component"
```

---

## Task 3: Shared VFS Helpers

Extract duplicated code from existing demos into reusable helpers.

**Files:**
- Create: `examples/browser/lib/init/shell-binaries.ts`
- Create: `examples/browser/lib/init/service-worker-bridge.ts`
- Create: `examples/browser/lib/init/nginx-config.ts`
- Create: `examples/browser/lib/init/php-fpm-config.ts`
- Create: `examples/browser/lib/init/mariadb-config.ts`

### Step 1: Extract shell binary population

Move `populateExecBinaries` from `pages/shell/main.ts` into a shared module. This is the code that writes dash, lazy utility binaries, and symlinks.

```typescript
// examples/browser/lib/init/shell-binaries.ts
//
// Shared helper that populates the VFS with dash + coreutils + utilities.
// Extracted from pages/shell/main.ts populateExecBinaries().
//
// Import URL references for each binary. The calling demo page must provide
// these as fetched ArrayBuffers or URL strings, since Vite URL imports are
// static per entry point.

import type { BrowserKernel } from "../browser-kernel";
import type { MemoryFileSystem } from "../../../../host/src/vfs/shared-fs";

/** Wasm binary definition for lazy loading */
export interface BinaryDef {
  url: string;
  path: string;
  size: number;
  symlinks: string[];
}

export const COREUTILS_NAMES = [
  "arch","b2sum","base32","base64","basename","cat","chcon","chgrp","chmod",
  "chown","chroot","cksum","comm","cp","csplit","cut","date","dd","df",
  "dir","dircolors","dirname","du","echo","env","expand","expr","factor",
  "false","fmt","fold","groups","head","hostid","id","install","join",
  "link","ln","logname","ls","md5sum","mkdir","mkfifo","mknod","mktemp",
  "mv","nice","nl","nohup","nproc","numfmt","od","paste","pathchk","pinky",
  "pr","printenv","printf","ptx","pwd","readlink","realpath","rm","rmdir",
  "runcon","seq","sha1sum","sha224sum","sha256sum","sha384sum","sha512sum",
  "shred","shuf","sleep","sort","split","stat","stdbuf","stty","sum",
  "sync","tac","tail","tee","test","timeout","touch","tr","true","truncate",
  "tsort","tty","uname","unexpand","uniq","unlink","users","vdir","wc",
  "who","whoami","yes",
];

/**
 * Populate the VFS with shell binaries: dash (eager) + utilities (lazy).
 *
 * @param kernel - BrowserKernel to populate
 * @param dashBytes - Pre-fetched dash wasm binary
 * @param lazyBinaries - Lazy binary definitions (from loadBinaryDefs())
 * @param dataFiles - Optional data files to write (e.g., magic database)
 */
export function populateShellBinaries(
  kernel: BrowserKernel,
  dashBytes: ArrayBuffer,
  lazyBinaries: BinaryDef[],
  dataFiles?: Array<{ path: string; data: Uint8Array | string }>,
): void {
  const fs = kernel.fs;

  // Create standard directories
  for (const dir of [
    "/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin",
    "/usr/share", "/usr/share/misc", "/usr/share/file",
    "/etc", "/root",
  ]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }

  // Write gitconfig
  const gitconfig = [
    "[maintenance]", "\tauto = false",
    "[gc]", "\tauto = 0",
    "[core]", "\tpager = cat",
    "[user]", "\tname = user", "\temail = user@localhost",
  ].join("\n") + "\n";
  writeFile(fs, "/etc/gitconfig", gitconfig);

  // Write dash eagerly
  writeFileBinary(fs, "/bin/dash", new Uint8Array(dashBytes));
  for (const link of ["/bin/sh", "/usr/bin/dash", "/usr/bin/sh"]) {
    try { fs.symlink("/bin/dash", link); } catch { /* exists */ }
  }

  // Register lazy binaries
  if (lazyBinaries.length > 0) {
    kernel.registerLazyFiles(
      lazyBinaries.map((b) => ({ path: b.path, url: b.url, size: b.size, mode: 0o755 })),
    );
    for (const bin of lazyBinaries) {
      for (const link of bin.symlinks) {
        try { fs.symlink(bin.path, link); } catch { /* exists */ }
      }
    }
  }

  // Write data files
  if (dataFiles) {
    for (const { path, data } of dataFiles) {
      if (typeof data === "string") writeFile(fs, path, data);
      else writeFileBinary(fs, path, data);
    }
  }
}

function writeFile(fs: MemoryFileSystem, path: string, content: string): void {
  const enc = new TextEncoder();
  const bytes = enc.encode(content);
  const fd = fs.open(path, 0o1101, 0o644); // O_WRONLY|O_CREAT|O_TRUNC
  fs.write(fd, bytes, 0, bytes.length);
  fs.close(fd);
}

function writeFileBinary(fs: MemoryFileSystem, path: string, data: Uint8Array): void {
  const fd = fs.open(path, 0o1101, 0o755);
  fs.write(fd, data, 0, data.length);
  fs.close(fd);
}
```

### Step 2: Extract service worker bridge init

```typescript
// examples/browser/lib/init/service-worker-bridge.ts
//
// Shared helper for registering the service worker and initializing
// the HTTP bridge. Extracted from the identical initBridge() functions
// duplicated across nginx, nginx-php, wordpress, and lamp demos.

import { HttpBridgeHost } from "../http-bridge";

/**
 * Register the service worker and wire up the HTTP bridge.
 * Returns the HttpBridgeHost (call detachHostPort() to get the port for the kernel).
 *
 * @param swUrl - URL to service-worker.js (typically BASE_URL + "service-worker.js")
 * @param appPrefix - App prefix for the service worker (e.g., "/app/" or "/pages/nginx/app/")
 */
export async function initServiceWorkerBridge(
  swUrl: string,
  appPrefix: string,
): Promise<HttpBridgeHost> {
  const bridge = new HttpBridgeHost();

  const reg = await navigator.serviceWorker.register(swUrl, { scope: "/" });
  await navigator.serviceWorker.ready;

  // Send bridge port + app prefix to service worker
  await new Promise<void>((resolve, reject) => {
    const mc = new MessageChannel();
    mc.port1.onmessage = (ev) => {
      if (ev.data?.type === "bridge-ready") resolve();
      else reject(new Error("Unexpected SW response: " + JSON.stringify(ev.data)));
    };
    reg.active!.postMessage(
      { type: "init-bridge", appPrefix },
      [bridge.getSwPort(), mc.port2],
    );
    setTimeout(() => reject(new Error("Service worker bridge init timeout")), 10000);
  });

  return bridge;
}
```

### Step 3: Extract nginx config helper

```typescript
// examples/browser/lib/init/nginx-config.ts

import type { MemoryFileSystem } from "../../../../host/src/vfs/shared-fs";

export interface NginxConfigOptions {
  /** Port to listen on (default 8080) */
  port?: number;
  /** Document root (default /var/www/html) */
  root?: string;
  /** Additional location blocks to add inside the server block */
  extraLocations?: string;
  /** Worker processes (default 2) */
  workerProcesses?: number;
}

/**
 * Write nginx.conf and create required directories.
 * Returns the config file path.
 */
export function populateNginxConfig(
  fs: MemoryFileSystem,
  options?: NginxConfigOptions,
): void {
  const port = options?.port ?? 8080;
  const root = options?.root ?? "/var/www/html";
  const extraLocations = options?.extraLocations ?? "";
  const workerProcesses = options?.workerProcesses ?? 2;

  // Create directories
  for (const dir of [
    "/etc/nginx", "/var/www/html", "/var/log/nginx",
    "/tmp/nginx_client_temp", "/tmp/nginx-wasm/logs",
  ]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }

  const conf = `worker_processes ${workerProcesses};
daemon off;
master_process on;
error_log /var/log/nginx/error.log info;
pid /tmp/nginx-wasm/nginx.pid;

events {
    worker_connections 64;
}

http {
    access_log off;
    client_body_temp_path /tmp/nginx_client_temp;
    proxy_temp_path /tmp/nginx_proxy_temp;
    fastcgi_temp_path /tmp/nginx_fastcgi_temp;
    uwsgi_temp_path /tmp/nginx_uwsgi_temp;
    scgi_temp_path /tmp/nginx_scgi_temp;

    types {
        text/html html htm;
        text/css css;
        text/javascript js mjs;
        application/json json;
        application/xml xml;
        image/png png;
        image/jpeg jpg jpeg;
        image/gif gif;
        image/svg+xml svg;
        application/octet-stream wasm;
        text/plain txt log;
    }
    default_type application/octet-stream;

    server {
        listen ${port};
        server_name localhost;
        root ${root};
        index index.html index.php;
${extraLocations}
    }
}
`;

  writeFile(fs, "/etc/nginx/nginx.conf", conf);
}

function writeFile(fs: MemoryFileSystem, path: string, content: string): void {
  const enc = new TextEncoder();
  const bytes = enc.encode(content);
  const fd = fs.open(path, 0o1101, 0o644);
  fs.write(fd, bytes, 0, bytes.length);
  fs.close(fd);
}
```

### Step 4: Extract PHP-FPM config helper

```typescript
// examples/browser/lib/init/php-fpm-config.ts

import type { MemoryFileSystem } from "../../../../host/src/vfs/shared-fs";

export interface PhpFpmConfigOptions {
  /** FastCGI listen address (default 127.0.0.1:9000) */
  listen?: string;
  /** Document root for the router (default /var/www/html) */
  root?: string;
  /** Max children (default 1) */
  maxChildren?: number;
}

/**
 * Write php-fpm.conf, fpm-router.php, and create required directories.
 */
export function populatePhpFpmConfig(
  fs: MemoryFileSystem,
  options?: PhpFpmConfigOptions,
): void {
  const listen = options?.listen ?? "127.0.0.1:9000";
  const root = options?.root ?? "/var/www/html";
  const maxChildren = options?.maxChildren ?? 1;

  // Create directories
  for (const dir of ["/etc/php-fpm.d", "/var/log"]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }

  const fpmConf = `[global]
error_log = /var/log/php-fpm.log
daemonize = no

[www]
listen = ${listen}
pm = static
pm.max_children = ${maxChildren}
php_admin_value[error_log] = /var/log/php-error.log
`;

  // FPM router: resolves SCRIPT_FILENAME from REQUEST_URI
  // Handles directory index (index.php) and PATHINFO
  const fpmRouter = `<?php
$uri = $_SERVER['REQUEST_URI'] ?? '/';
$path = parse_url($uri, PHP_URL_PATH);
$docRoot = '${root}';
$scriptPath = $docRoot . $path;

// Directory index
if (is_dir($scriptPath)) {
    $scriptPath = rtrim($scriptPath, '/') . '/index.php';
}

// Direct .php file
if (file_exists($scriptPath) && pathinfo($scriptPath, PATHINFO_EXTENSION) === 'php') {
    $_SERVER['SCRIPT_FILENAME'] = $scriptPath;
    $_SERVER['SCRIPT_NAME'] = $path;
    chdir(dirname($scriptPath));
    require $scriptPath;
    return true;
}

// PATH_INFO: find nearest .php in path
$parts = explode('/', ltrim($path, '/'));
$check = $docRoot;
for ($i = 0; $i < count($parts); $i++) {
    $check .= '/' . $parts[$i];
    if (file_exists($check) && pathinfo($check, PATHINFO_EXTENSION) === 'php') {
        $_SERVER['SCRIPT_FILENAME'] = $check;
        $_SERVER['SCRIPT_NAME'] = '/' . implode('/', array_slice($parts, 0, $i + 1));
        $_SERVER['PATH_INFO'] = '/' . implode('/', array_slice($parts, $i + 1));
        chdir(dirname($check));
        require $check;
        return true;
    }
}

// Front controller fallback
$front = $docRoot . '/index.php';
if (file_exists($front)) {
    $_SERVER['SCRIPT_FILENAME'] = $front;
    $_SERVER['SCRIPT_NAME'] = '/index.php';
    chdir($docRoot);
    require $front;
    return true;
}

http_response_code(404);
echo "Not Found";
`;

  writeFile(fs, "/etc/php-fpm.conf", fpmConf);
  writeFile(fs, "/etc/fpm-router.php", fpmRouter);
}

function writeFile(fs: MemoryFileSystem, path: string, content: string): void {
  const enc = new TextEncoder();
  const bytes = enc.encode(content);
  const fd = fs.open(path, 0o1101, 0o644);
  fs.write(fd, bytes, 0, bytes.length);
  fs.close(fd);
}
```

### Step 5: Extract MariaDB config helper

```typescript
// examples/browser/lib/init/mariadb-config.ts

import type { MemoryFileSystem } from "../../../../host/src/vfs/shared-fs";

/**
 * Create MariaDB data directories.
 */
export function populateMariadbDirs(fs: MemoryFileSystem): void {
  for (const dir of ["/data", "/data/mysql", "/data/tmp", "/data/test"]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }
}

function writeFile(fs: MemoryFileSystem, path: string, content: string): void {
  const enc = new TextEncoder();
  const bytes = enc.encode(content);
  const fd = fs.open(path, 0o1101, 0o644);
  fs.write(fd, bytes, 0, bytes.length);
  fs.close(fd);
}
```

### Step 6: Commit

```bash
git add examples/browser/lib/init/
git commit -m "feat(browser): extract shared VFS helpers for init system"
```

---

## Task 4: SystemInit Class

**Files:**
- Create: `examples/browser/lib/init/system-init.ts`
- Create: `examples/browser/lib/init/index.ts` (barrel export)
- Test: `host/test/browser-system-init.test.ts`

### Step 1: Write the SystemInit class

```typescript
// examples/browser/lib/init/system-init.ts

import type { BrowserKernel } from "../browser-kernel";
import { PtyTerminal, type PtyTerminalOptions } from "../pty-terminal";
import { TerminalPanel } from "../terminal-panel";
import { parseServiceDescriptor, type ServiceDescriptor } from "./service-descriptor";
import { initServiceWorkerBridge } from "./service-worker-bridge";

export interface SystemInitOptions {
  /** Callback for boot log messages */
  onLog?: (message: string, level: "info" | "stderr" | "error") => void;
  /** Called when a service becomes ready */
  onServiceReady?: (name: string, pid: number) => void;
  /** Container element for the collapsible terminal panel (null = no shell UI) */
  terminalContainer?: HTMLElement | null;
  /** Base URL for service worker registration (if any service uses bridge) */
  serviceWorkerUrl?: string;
  /** App prefix for service worker HTTP interception */
  appPrefix?: string;
  /** PtyTerminal options override */
  ptyOptions?: PtyTerminalOptions;
}

interface RunningService {
  descriptor: ServiceDescriptor;
  pid: number;
  exitPromise: Promise<number>;
  ready: boolean;
}

export class SystemInit {
  private kernel: BrowserKernel;
  private options: SystemInitOptions;
  private services = new Map<string, RunningService>();
  private terminalPanel: TerminalPanel | null = null;
  private ptyTerminal: PtyTerminal | null = null;

  constructor(kernel: BrowserKernel, options?: SystemInitOptions) {
    this.kernel = kernel;
    this.options = options ?? {};
  }

  /** Read /etc/init.d/ from the VFS, parse service descriptors, boot in order. */
  async boot(): Promise<void> {
    const descriptors = this.readServiceDescriptors();
    if (descriptors.length === 0) {
      this.log("No services found in /etc/init.d/", "info");
      return;
    }

    // Sort by order (filename prefix)
    descriptors.sort((a, b) => a.order - b.order);

    this.log(`Boot: ${descriptors.map((d) => d.name).join(" -> ")}`, "info");

    // Set up HTTP bridge if any service needs it
    const bridgeServices = descriptors.filter((d) => d.bridge != null);
    if (bridgeServices.length > 0) {
      await this.setupBridge(bridgeServices[0].bridge!);
    }

    // Boot each service in order
    for (const desc of descriptors) {
      await this.bootService(desc);
    }
  }

  /** Get the PtyTerminal for the interactive shell (if any) */
  getPtyTerminal(): PtyTerminal | null {
    return this.ptyTerminal;
  }

  /** Get the TerminalPanel UI component */
  getTerminalPanel(): TerminalPanel | null {
    return this.terminalPanel;
  }

  /** Get a running service by name */
  getService(name: string): RunningService | undefined {
    return this.services.get(name);
  }

  /** Shut down all services in reverse order */
  async shutdown(): Promise<void> {
    const ordered = [...this.services.values()].reverse();
    for (const svc of ordered) {
      this.log(`Stopping ${svc.descriptor.name} (pid ${svc.pid})...`, "info");
      await this.kernel.terminateProcess(svc.pid);
    }
    this.services.clear();
    if (this.ptyTerminal) {
      this.ptyTerminal.dispose();
      this.ptyTerminal = null;
    }
    if (this.terminalPanel) {
      this.terminalPanel.dispose();
      this.terminalPanel = null;
    }
  }

  // -- Private --

  private readServiceDescriptors(): ServiceDescriptor[] {
    const fs = this.kernel.fs;
    const initDir = "/etc/init.d";

    let entries: string[];
    try {
      entries = this.listDirectory(fs, initDir);
    } catch {
      return [];
    }

    const descriptors: ServiceDescriptor[] = [];
    const decoder = new TextDecoder();
    for (const entry of entries) {
      const path = `${initDir}/${entry}`;
      try {
        const fd = fs.open(path, 0 /* O_RDONLY */, 0);
        const stat = fs.fstat(fd);
        const buf = new Uint8Array(stat.size);
        fs.read(fd, buf, 0, buf.length, 0);
        fs.close(fd);
        const content = decoder.decode(buf);
        descriptors.push(parseServiceDescriptor(entry, content));
      } catch (e) {
        this.log(`Failed to parse ${path}: ${e}`, "error");
      }
    }
    return descriptors;
  }

  private listDirectory(fs: any, path: string): string[] {
    // MemoryFileSystem.readdir returns [name, type][] pairs
    const entries: Array<[string, number]> = fs.readdir(path);
    return entries
      .map(([name]: [string, number]) => name)
      .filter((name: string) => name !== "." && name !== "..");
  }

  private async setupBridge(port: number): Promise<void> {
    if (!this.options.serviceWorkerUrl || !this.options.appPrefix) {
      this.log("Warning: bridge service found but no serviceWorkerUrl/appPrefix configured", "error");
      return;
    }
    this.log("Initializing HTTP bridge...", "info");
    const bridge = await initServiceWorkerBridge(
      this.options.serviceWorkerUrl,
      this.options.appPrefix,
    );
    this.kernel.sendBridgePort(bridge.detachHostPort(), port);
    this.log("HTTP bridge ready", "info");
  }

  private async bootService(desc: ServiceDescriptor): Promise<void> {
    // Wait for dependencies
    if (desc.depends) {
      for (const dep of desc.depends) {
        const depSvc = this.services.get(dep);
        if (!depSvc) {
          this.log(`Warning: ${desc.name} depends on ${dep} which was not started`, "error");
          continue;
        }
        if (!depSvc.ready) {
          this.log(`Waiting for dependency ${dep}...`, "info");
          await this.waitForReady(depSvc);
        }
      }
    }

    this.log(`Starting ${desc.name}: ${desc.command.join(" ")}`, "info");

    if (desc.type === "interactive") {
      await this.bootInteractive(desc);
    } else if (desc.type === "oneshot") {
      await this.bootOneshot(desc);
    } else {
      await this.bootDaemon(desc);
    }
  }

  private async bootDaemon(desc: ServiceDescriptor): Promise<void> {
    const binaryPath = desc.command[0];
    const programBytes = this.readBinaryFromVfs(binaryPath);

    const exitPromise = this.kernel.spawn(programBytes, desc.command, {
      env: desc.env,
      cwd: desc.cwd,
    });

    const pid = (this.kernel as any).nextPid - 1;
    const svc: RunningService = { descriptor: desc, pid, exitPromise, ready: false };
    this.services.set(desc.name, svc);

    // Log unexpected exits
    exitPromise.then((code) => {
      this.log(`${desc.name} (pid ${pid}) exited with code ${code}`, code === 0 ? "info" : "error");
    });

    // Wait for readiness
    await this.waitForReady(svc);
    this.log(`${desc.name} ready (pid ${pid})`, "info");
    this.options.onServiceReady?.(desc.name, pid);
  }

  private async bootOneshot(desc: ServiceDescriptor): Promise<void> {
    const binaryPath = desc.command[0];
    const programBytes = this.readBinaryFromVfs(binaryPath);

    let stdin: Uint8Array | undefined;
    if (desc.stdin) {
      stdin = this.readFileFromVfs(desc.stdin);
    }

    const exitPromise = this.kernel.spawn(programBytes, desc.command, {
      env: desc.env,
      cwd: desc.cwd,
      stdin,
    });

    const pid = (this.kernel as any).nextPid - 1;
    const svc: RunningService = { descriptor: desc, pid, exitPromise, ready: false };
    this.services.set(desc.name, svc);

    // Wait for readiness (typically "exit" or "stdin-consumed")
    await this.waitForReady(svc);
    this.log(`${desc.name} completed (pid ${pid})`, "info");
    this.options.onServiceReady?.(desc.name, pid);
  }

  private async bootInteractive(desc: ServiceDescriptor): Promise<void> {
    const binaryPath = desc.command[0];
    const programBytes = this.readBinaryFromVfs(binaryPath);

    // Create terminal panel if container provided
    if (this.options.terminalContainer) {
      this.terminalPanel = new TerminalPanel(this.options.terminalContainer);
      this.terminalPanel.setStatus("Starting shell...");
    }

    const container = this.terminalPanel?.getTerminalContainer()
      ?? document.createElement("div"); // headless fallback

    this.ptyTerminal = new PtyTerminal(container, this.kernel, this.options.ptyOptions);

    // Wire up panel expand -> terminal fit
    if (this.terminalPanel) {
      this.terminalPanel.onExpand(() => this.ptyTerminal?.fit());
    }

    const exitPromise = this.ptyTerminal.spawn(programBytes, desc.command, {
      env: desc.env,
      cwd: desc.cwd ?? "/root",
    });

    const pid = (this.kernel as any).nextPid - 1;
    const svc: RunningService = { descriptor: desc, pid, exitPromise, ready: true };
    this.services.set(desc.name, svc);

    if (this.terminalPanel) {
      this.terminalPanel.setStatus("Shell ready");
    }

    this.log(`Shell started (pid ${pid})`, "info");
    this.options.onServiceReady?.(desc.name, pid);
  }

  private async waitForReady(svc: RunningService): Promise<void> {
    const ready = svc.descriptor.ready;
    if (!ready) {
      // No readiness condition — mark ready immediately
      svc.ready = true;
      return;
    }

    switch (ready.kind) {
      case "delay":
        await new Promise((r) => setTimeout(r, ready.ms));
        svc.ready = true;
        break;

      case "port":
        for (let attempt = 1; attempt <= 60; attempt++) {
          await new Promise((r) => setTimeout(r, 1000));
          const target = await this.kernel.pickListenerTarget(ready.port);
          if (target) {
            svc.ready = true;
            return;
          }
        }
        this.log(`Warning: ${svc.descriptor.name} port ${ready.port} not ready after 60s`, "error");
        svc.ready = true; // proceed anyway
        break;

      case "exit":
        await svc.exitPromise;
        svc.ready = true;
        break;

      case "stdin-consumed": {
        for (let attempt = 1; attempt <= 1200; attempt++) {
          if (await this.kernel.isStdinConsumed(svc.pid)) {
            // Give a moment for final processing
            await new Promise((r) => setTimeout(r, 2000));
            svc.ready = true;
            return;
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        this.log(`Warning: ${svc.descriptor.name} stdin not consumed after 600s`, "error");
        svc.ready = true;
        break;
      }
    }
  }

  private readBinaryFromVfs(path: string): ArrayBuffer {
    const fs = this.kernel.fs;
    // Follow symlinks by reading the target
    let resolvedPath = path;
    try {
      resolvedPath = fs.readlink(path);
    } catch { /* not a symlink, use original path */ }

    const fd = fs.open(resolvedPath, 0 /* O_RDONLY */, 0);
    const stat = fs.fstat(fd);
    const buf = new Uint8Array(stat.size);
    fs.read(fd, buf, 0, buf.length, 0);
    fs.close(fd);
    return buf.buffer;
  }

  private readFileFromVfs(path: string): Uint8Array {
    const fs = this.kernel.fs;
    const fd = fs.open(path, 0 /* O_RDONLY */, 0);
    const stat = fs.fstat(fd);
    const buf = new Uint8Array(stat.size);
    fs.read(fd, buf, 0, buf.length, 0);
    fs.close(fd);
    return buf;
  }

  private log(message: string, level: "info" | "stderr" | "error"): void {
    this.options.onLog?.(message + "\n", level);
  }
}
```

### Step 2: Create barrel export

```typescript
// examples/browser/lib/init/index.ts
export { SystemInit, type SystemInitOptions } from "./system-init";
export { parseServiceDescriptor, type ServiceDescriptor, type ReadyCondition } from "./service-descriptor";
export { TerminalPanel } from "../terminal-panel";
export { populateShellBinaries, type BinaryDef, COREUTILS_NAMES } from "./shell-binaries";
export { initServiceWorkerBridge } from "./service-worker-bridge";
export { populateNginxConfig, type NginxConfigOptions } from "./nginx-config";
export { populatePhpFpmConfig, type PhpFpmConfigOptions } from "./php-fpm-config";
export { populateMariadbDirs } from "./mariadb-config";
```

### Step 3: Commit

```bash
git add examples/browser/lib/init/system-init.ts examples/browser/lib/init/index.ts
git commit -m "feat(browser): add SystemInit class for /etc/init.d/ boot orchestration"
```

---

## Task 5: VFS writeFile Utility

A small helper used across all config writers and SystemInit to avoid copy-pasting the open/write/close pattern. All the config helpers in Task 3 duplicate this — extract once.

**Files:**
- Create: `examples/browser/lib/init/vfs-utils.ts`
- Modify: All config helpers from Task 3 to import from vfs-utils

### Step 1: Create vfs-utils

```typescript
// examples/browser/lib/init/vfs-utils.ts

import type { MemoryFileSystem } from "../../../../host/src/vfs/shared-fs";

const encoder = new TextEncoder();

/** Write a text file to the VFS, creating parent dirs as needed. */
export function writeVfsFile(fs: MemoryFileSystem, path: string, content: string, mode = 0o644): void {
  const bytes = encoder.encode(content);
  const fd = fs.open(path, 0o1101, mode); // O_WRONLY|O_CREAT|O_TRUNC
  fs.write(fd, bytes, 0, bytes.length);
  fs.close(fd);
}

/** Write binary data to the VFS. */
export function writeVfsBinary(fs: MemoryFileSystem, path: string, data: Uint8Array, mode = 0o755): void {
  const fd = fs.open(path, 0o1101, mode);
  fs.write(fd, data, 0, data.length);
  fs.close(fd);
}

/** Ensure a directory exists (mkdir, ignore EEXIST). */
export function ensureDir(fs: MemoryFileSystem, path: string, mode = 0o755): void {
  try { fs.mkdir(path, mode); } catch { /* exists */ }
}

/** Ensure multiple directories exist. */
export function ensureDirs(fs: MemoryFileSystem, paths: string[]): void {
  for (const p of paths) ensureDir(fs, p);
}

/** Write a service descriptor to /etc/init.d/. */
export function writeInitDescriptor(
  fs: MemoryFileSystem,
  filename: string,
  fields: Record<string, string | undefined>,
): void {
  ensureDir(fs, "/etc");
  ensureDir(fs, "/etc/init.d");
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) lines.push(`${key}=${value}`);
  }
  writeVfsFile(fs, `/etc/init.d/${filename}`, lines.join("\n") + "\n");
}
```

### Step 2: Update config helpers to use vfs-utils

Replace the local `writeFile` functions in nginx-config.ts, php-fpm-config.ts, mariadb-config.ts, and shell-binaries.ts with imports from vfs-utils.

### Step 3: Commit

```bash
git add examples/browser/lib/init/vfs-utils.ts
git commit -m "refactor(browser): extract VFS write utilities for init helpers"
```

---

## Task 6: Refactor nginx Demo

The simplest daemon demo. Proof of concept for the init system.

**Files:**
- Modify: `examples/browser/pages/nginx/main.ts`
- Modify: `examples/browser/pages/nginx/index.html` (add terminal panel container)

### Step 1: Update HTML to support terminal panel

Add a flex layout wrapper and terminal container to the existing HTML. Keep all existing content elements.

The key HTML change: wrap existing content in a `#content` div, add a `#terminal-panel` div as sibling, wrap both in a `#app` flex container.

```html
<div id="app" style="display:flex;flex-direction:column;height:100vh">
  <div id="content" style="flex:1;overflow:auto">
    <!-- existing demo content: controls, log, iframe -->
  </div>
  <div id="terminal-panel" style="height:40vh"></div>
</div>
```

The terminal panel starts collapsed (32px bar), so the demo content gets nearly full height until the user expands it.

### Step 2: Rewrite main.ts to use SystemInit

Replace the manual orchestration with:
1. Fetch kernel + nginx + dash wasm (+ lazy utility sizes)
2. Create BrowserKernel
3. Populate VFS: nginx binary, nginx config, shell binaries, init descriptors
4. Create SystemInit with terminal container
5. Call `init.boot()`
6. Load iframe after boot completes

The init descriptors:
```
# /etc/init.d/10-nginx
type=daemon
command=/usr/sbin/nginx -p /etc/nginx -c nginx.conf
ready=port:8080
bridge=8080
```
```
# /etc/init.d/99-shell
type=interactive
command=/bin/dash -i
env=TERM=xterm-256color PS1=\w\$\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin
pty=true
```

### Step 3: Test manually

Run: `cd examples/browser && npx vite dev`
Navigate to the nginx demo page. Verify:
- nginx starts and serves the iframe content
- Terminal panel bar visible at bottom
- Clicking it expands to show a working shell
- Shell can run `ls /etc/init.d/`, `cat /etc/init.d/10-nginx`, `ls /bin/`
- Shell can run basic coreutils (`ls`, `cat`, `echo`, `pwd`)

### Step 4: Commit

```bash
git add examples/browser/pages/nginx/
git commit -m "refactor(browser): nginx demo uses init system + shell terminal"
```

---

## Task 7: Refactor nginx-php Demo

**Files:**
- Modify: `examples/browser/pages/nginx-php/main.ts`
- Modify: `examples/browser/pages/nginx-php/index.html`

### Step 1: Update HTML (same flex layout pattern as Task 6)

### Step 2: Rewrite main.ts

Init descriptors:
```
# /etc/init.d/10-php-fpm
type=daemon
command=/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize
ready=delay:3000

# /etc/init.d/20-nginx
type=daemon
command=/usr/sbin/nginx -p /etc/nginx -c nginx.conf
depends=php-fpm
ready=port:8080
bridge=8080

# /etc/init.d/99-shell
type=interactive
command=/bin/dash -i
env=TERM=xterm-256color PS1=\w\$\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin
pty=true
```

VFS setup: php-fpm binary (lazy), nginx binary (lazy), shell binaries, `populateNginxConfig()` with FastCGI locations, `populatePhpFpmConfig()`, index.php.

The nginx extraLocations for FastCGI passthrough:
```nginx
        location ~ \.php$ {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_param SCRIPT_FILENAME /etc/fpm-router.php;
            include /dev/null;
        }
```

### Step 3: Test manually

Verify PHP page loads in iframe, shell works, `cat /etc/init.d/10-php-fpm` shows config.

### Step 4: Commit

```bash
git add examples/browser/pages/nginx-php/
git commit -m "refactor(browser): nginx-php demo uses init system + shell terminal"
```

---

## Task 8: Refactor redis Demo

**Files:**
- Modify: `examples/browser/pages/redis/main.ts`
- Modify: `examples/browser/pages/redis/index.html`

### Step 1: Update HTML

### Step 2: Rewrite main.ts

Init descriptors:
```
# /etc/init.d/10-redis
type=daemon
command=/usr/sbin/redis-server --port 6379 --bind 0.0.0.0 --save "" --appendonly no --io-threads 1
ready=port:6379

# /etc/init.d/99-shell
type=interactive
command=/bin/dash -i
env=TERM=xterm-256color PS1=\w\$\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin
pty=true
```

Note: Redis uses threads, so `BrowserKernel` must be created with `maxWorkers: 8`. The thread module pre-compilation is handled automatically (Task 10, or left as-is for now — pass `threadModule` option to BrowserKernel if auto-compilation isn't implemented yet).

VFS: redis binary, mariadb dirs (/data, /data/tmp), shell binaries, init descriptors.

The Redis demo also has a custom Redis RESP client UI. This stays in the `#content` area above the terminal.

### Step 3: Test: redis server starts, RESP client works, shell works

### Step 4: Commit

```bash
git add examples/browser/pages/redis/
git commit -m "refactor(browser): redis demo uses init system + shell terminal"
```

---

## Task 9: Refactor mariadb Demo

The MariaDB demo has a two-phase bootstrap: run mariadbd in `--bootstrap` mode (oneshot), then start the server (daemon).

**Files:**
- Modify: `examples/browser/pages/mariadb/main.ts`
- Modify: `examples/browser/pages/mariadb/index.html`

### Step 1: Update HTML

### Step 2: Rewrite main.ts

Init descriptors:
```
# /etc/init.d/05-mariadb-bootstrap
type=oneshot
command=/usr/sbin/mariadbd --bootstrap --datadir=/data --tmpdir=/data/tmp --skip-networking --log-error=/data/bootstrap.log
stdin=/etc/mariadb/bootstrap.sql
ready=stdin-consumed

# /etc/init.d/10-mariadb
type=daemon
command=/usr/sbin/mariadbd --datadir=/data --tmpdir=/data/tmp --skip-networking=0 --port=3306 --thread-handling=no-threads --skip-grant-tables --default-storage-engine=Aria --log-error=/data/error.log
depends=mariadb-bootstrap
ready=port:3306

# /etc/init.d/99-shell
type=interactive
command=/bin/dash -i
env=TERM=xterm-256color PS1=\w\$\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin
pty=true
```

Special handling: After the oneshot bootstrap completes (`stdin-consumed`), SystemInit needs to terminate the bootstrap process (MariaDB hangs after bootstrap instead of exiting cleanly). This is a MariaDB-specific behavior.

**Options:**
1. Add a `terminate-after-ready=true` field to the service descriptor
2. Handle it in the demo page after `init.boot()` by checking if the bootstrap process is still running

Option 1 is cleaner. Add `terminate=true` field to ServiceDescriptor:
```
# /etc/init.d/05-mariadb-bootstrap
...
ready=stdin-consumed
terminate=true
```

When `terminate=true` and the ready condition is met, SystemInit calls `kernel.terminateProcess(pid)` before moving on.

VFS: mariadbd binary (eager — needed for both phases, and it's the same binary), bootstrap SQL file at `/etc/mariadb/bootstrap.sql`, data dirs, shell binaries.

The MySQL RESP client UI stays in `#content`.

### Step 3: Update ServiceDescriptor and parser

Add `terminate?: boolean` to ServiceDescriptor. Parse `terminate=true` in the parser.

### Step 4: Test: bootstrap completes, server starts, SQL client connects, shell works

### Step 5: Commit

```bash
git add examples/browser/pages/mariadb/ examples/browser/lib/init/
git commit -m "refactor(browser): mariadb demo uses init system + shell terminal"
```

---

## Task 10: Refactor wordpress Demo

**Files:**
- Modify: `examples/browser/pages/wordpress/main.ts`
- Modify: `examples/browser/pages/wordpress/index.html`

### Step 1: Update HTML

### Step 2: Rewrite main.ts

The WordPress demo has an important optimization: PHP-FPM and nginx are started BEFORE loading the WordPress bundle, because fork children inherit the SharedArrayBuffer-backed VFS. Files loaded after fork are visible to all workers. This saves memory since fork children get lightweight snapshots.

This means the WordPress bundle loading should happen AFTER the daemon services start but BEFORE the shell (or at least before the iframe loads). This can be handled by having the demo page:
1. Call `init.boot()` (starts php-fpm, nginx)
2. Load WordPress bundle into VFS
3. Load iframe

But wait — the init system boots everything including the shell in `boot()`. We need a way to inject work between services.

**Solution:** Add an `onBeforeService` callback to SystemInitOptions:
```typescript
onBeforeService?: (name: string, descriptor: ServiceDescriptor) => Promise<void>;
```

SystemInit calls this before starting each service. The WordPress demo uses it to load the bundle before the shell (but after nginx):

```typescript
const init = new SystemInit(kernel, {
  onBeforeService: async (name) => {
    if (name === "shell") {
      await loadWordPressBundle(kernel.fs, wpBundleUrl);
      overwriteWpConfig(kernel.fs);
    }
  },
});
```

Init descriptors:
```
# /etc/init.d/10-php-fpm
type=daemon
command=/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize
ready=delay:5000

# /etc/init.d/20-nginx
type=daemon
command=/usr/sbin/nginx -p /etc/nginx -c nginx.conf
depends=php-fpm
ready=delay:3000
bridge=8080

# /etc/init.d/99-shell
type=interactive
command=/bin/dash -i
env=TERM=xterm-256color PS1=\w\$\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin
pty=true
```

VFS: php-fpm binary (lazy), nginx binary (lazy), shell binaries, nginx config (with FastCGI), php-fpm config, init descriptors. WordPress bundle loaded via callback.

BrowserKernel options: `maxWorkers: 8, fsSize: 256MB, maxMemoryPages: 4096`.

### Step 3: Update SystemInit to support onBeforeService callback

Add the callback to SystemInitOptions and call it in `bootService()` before starting each service.

### Step 4: Test: WordPress loads, can log in, shell works

### Step 5: Commit

```bash
git add examples/browser/pages/wordpress/ examples/browser/lib/init/
git commit -m "refactor(browser): wordpress demo uses init system + shell terminal"
```

---

## Task 11: Refactor lamp Demo

The most complex demo: MariaDB bootstrap + server + PHP-FPM + nginx + WordPress bundle.

**Files:**
- Modify: `examples/browser/pages/lamp/main.ts`
- Modify: `examples/browser/pages/lamp/index.html`

### Step 1: Update HTML

### Step 2: Rewrite main.ts

Init descriptors:
```
# /etc/init.d/05-mariadb-bootstrap
type=oneshot
command=/usr/sbin/mariadbd --bootstrap --datadir=/data --tmpdir=/data/tmp --skip-networking --log-error=/data/bootstrap.log
stdin=/etc/mariadb/bootstrap.sql
ready=stdin-consumed
terminate=true

# /etc/init.d/10-mariadb
type=daemon
command=/usr/sbin/mariadbd --datadir=/data --tmpdir=/data/tmp --skip-networking=0 --port=3306 --thread-handling=no-threads --skip-grant-tables --default-storage-engine=Aria --log-error=/data/error.log
depends=mariadb-bootstrap
ready=port:3306

# /etc/init.d/20-php-fpm
type=daemon
command=/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize
depends=mariadb
ready=delay:3000

# /etc/init.d/30-nginx
type=daemon
command=/usr/sbin/nginx -p /etc/nginx -c nginx.conf
depends=php-fpm
ready=delay:2000
bridge=8080

# /etc/init.d/99-shell
type=interactive
command=/bin/dash -i
env=TERM=xterm-256color PS1=\w\$\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin
pty=true
```

Same `onBeforeService` pattern as WordPress for bundle loading.

BrowserKernel options: `maxWorkers: 16, fsSize: 128MB, threadModule: precompiled`.

Note: The LAMP demo still needs the thread module for MariaDB. Until auto-compilation is implemented, keep the manual `patchWasmForThread` + `WebAssembly.compile` in the demo page and pass it as a BrowserKernel option.

VFS: mariadbd (eager), php-fpm (lazy), nginx (lazy), shell binaries, all configs, bootstrap SQL, init descriptors.

### Step 3: Test: full LAMP stack boots, WordPress loads, shell works

### Step 4: Commit

```bash
git add examples/browser/pages/lamp/
git commit -m "refactor(browser): lamp demo uses init system + shell terminal"
```

---

## Task 12: Update Shell Demo to Reuse Shared Helpers

The shell demo (`pages/shell/main.ts`) was the source of `populateExecBinaries`. Now that it's extracted to `shell-binaries.ts`, update the shell demo to use the shared helper. This avoids two copies of the same binary population logic drifting apart.

**Files:**
- Modify: `examples/browser/pages/shell/main.ts`

### Step 1: Replace inline populateExecBinaries with import from shared helper

Keep the shell demo's existing structure (PtyTerminal without SystemInit, since it IS the shell — no daemons). Just swap out the binary population code.

### Step 2: Test: shell demo still works identically

### Step 3: Commit

```bash
git add examples/browser/pages/shell/
git commit -m "refactor(browser): shell demo uses shared shell-binaries helper"
```

---

## Task 13: Auto Thread Module Compilation

Remove the need for manually pre-compiling thread modules. Make the kernel worker lazily compile on first `onClone`.

**Files:**
- Modify: `examples/browser/lib/kernel-worker-entry.ts`
- Modify: `examples/browser/lib/browser-kernel.ts` (deprecate `threadModule` option)
- Modify: `examples/browser/pages/mariadb/main.ts` (remove manual precompilation)
- Modify: `examples/browser/pages/redis/main.ts` (remove manual precompilation)
- Modify: `examples/browser/pages/lamp/main.ts` (remove manual precompilation)

### Step 1: Add per-process thread module caching to kernel-worker-entry.ts

In `onClone`, before using `initData.programModule`:
1. Check a `Map<number, WebAssembly.Module>` keyed by pid (the parent process)
2. If not cached, call `patchWasmForThread(programBytes)` + `WebAssembly.compile()` (async is fine — clone blocks on channel)
3. Cache the result
4. Use the cached module for thread instantiation

The parent's program bytes are already available in the kernel worker (stored during spawn). Add a `Map<number, ArrayBuffer>` to track program bytes per pid.

### Step 2: Remove manual threadModule from demo pages

Remove `patchWasmForThread` import and pre-compilation from mariadb, redis, and lamp demos. Remove `threadModule` from BrowserKernel constructor calls.

### Step 3: Test: MariaDB, Redis, LAMP demos still create threads correctly

### Step 4: Commit

```bash
git add examples/browser/lib/kernel-worker-entry.ts examples/browser/lib/browser-kernel.ts examples/browser/pages/mariadb/ examples/browser/pages/redis/ examples/browser/pages/lamp/
git commit -m "feat(browser): auto thread module compilation on first clone"
```

---

## Task 14: Final Verification

### Step 1: Run full test suite

```bash
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib
cd host && npx vitest run
scripts/run-libc-tests.sh
scripts/run-posix-tests.sh
```

### Step 2: Manual browser verification

Run `cd examples/browser && npx vite dev` and verify each daemon demo:
- [ ] nginx: static page loads, shell works, `cat /etc/init.d/10-nginx` shows config
- [ ] nginx-php: PHP page loads, shell works
- [ ] redis: RESP client connects, shell works
- [ ] mariadb: bootstrap completes, SQL client connects, shell works
- [ ] wordpress: WordPress loads, shell works
- [ ] lamp: full stack boots, WordPress loads, shell works
- [ ] shell: unchanged behavior, shared binaries helper works
- [ ] simple: unchanged
- [ ] php: unchanged
- [ ] python: unchanged

### Step 3: Commit any fixes from verification

### Step 4: Create PR

```bash
git push -u origin init-system
gh pr create --title "feat(browser): init system with shell for daemon demos" --body "..."
```
