import { existsSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { NodeKernelHost } from "../../host/src/node-kernel-host";
import { findRepoRoot, tryResolveBinary } from "../../host/src/binary-resolver";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import { ensureDirRecursive, writeVfsFile } from "../../host/src/vfs/image-helpers";

export const SERVICE_DEMO_ENV = [
  "HOME=/root",
  "TERM=xterm-256color",
  "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
  "TMPDIR=/tmp",
];

export interface ServiceVfsImageRef {
  /** Resolver path, for example `programs/nginx-vfs.vfs.zst`. */
  relPath: string;
  /** Fallback filename under apps/browser-demos/public for local builds. */
  publicFile: string;
  /** Human-readable build command included in errors. */
  buildHint: string;
}

export interface BootDinitServiceOptions {
  image: ServiceVfsImageRef;
  target?: string;
  maxWorkers?: number;
  maxPages?: number;
  configure?: (fs: MemoryFileSystem) => void | Promise<void>;
  env?: string[];
  cwd?: string;
}

export interface BootedDinitService {
  host: NodeKernelHost;
  exitPromise: Promise<number>;
}

export async function bootDinitServiceVfs(options: BootDinitServiceOptions): Promise<BootedDinitService> {
  const imagePath = resolveServiceVfsImage(options.image);
  const image = readFileSync(imagePath);
  const fs = MemoryFileSystem.fromImage(image, {
    maxByteLength: 1024 * 1024 * 1024,
  });
  await options.configure?.(fs);

  const dinitBytes = readVfsBytes(fs, "/sbin/dinit");
  const rootfsImage = await fs.saveImage();

  const host = new NodeKernelHost({
    maxWorkers: options.maxWorkers ?? 12,
    maxPages: options.maxPages,
    rootfsImage,
    onStdout: (_pid, data) => process.stdout.write(data),
    onStderr: (_pid, data) => process.stderr.write(data),
  });
  await host.init();

  const argv = ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"];
  if (options.target) argv.push(options.target);

  const exitPromise = host.spawn(dinitBytes, argv, {
    env: options.env ?? SERVICE_DEMO_ENV,
    cwd: options.cwd ?? "/",
  });

  return { host, exitPromise };
}

export function resolveServiceVfsImage(image: ServiceVfsImageRef): string {
  const resolved = tryResolveBinary(image.relPath);
  if (resolved) return resolved;

  const publicPath = join(findRepoRoot(), "apps", "browser-demos", "public", image.publicFile);
  if (existsSync(publicPath)) return publicPath;

  throw new Error(
    `Service VFS image not found: ${image.relPath}\n` +
      `  checked resolver/local-binaries path for ${image.relPath}\n` +
      `  checked: ${publicPath}\n` +
      `  Build it with: ${image.buildHint}`,
  );
}

export function readVfsBytes(fs: MemoryFileSystem, path: string): ArrayBuffer {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const out = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < out.byteLength) {
      const n = fs.read(fd, out.subarray(offset), null, out.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return out.buffer.slice(out.byteOffset, out.byteOffset + offset);
  } finally {
    fs.close(fd);
  }
}

export function readVfsText(fs: MemoryFileSystem, path: string): string {
  return new TextDecoder().decode(readVfsBytes(fs, path));
}

export function rewriteNginxListenPort(fs: MemoryFileSystem, port: number): void {
  const path = "/etc/nginx/nginx.conf";
  const conf = readVfsText(fs, path);
  const updated = conf.replace(/listen\s+8080\b/g, `listen ${port}`);
  writeVfsFile(fs, path, updated);
}

export function rewriteDinitServiceCommand(
  fs: MemoryFileSystem,
  service: string,
  rewrite: (command: string) => string,
): void {
  const path = `/etc/dinit.d/${service}`;
  const conf = readVfsText(fs, path);
  const updated = conf.replace(/^command\s*=\s*(.*)$/m, (_line, command: string) => {
    return `command = ${rewrite(command)}`;
  });
  writeVfsFile(fs, path, updated);
}

export function removeServiceLogfiles(fs: MemoryFileSystem, services: string[]): void {
  for (const service of services) {
    const path = `/etc/dinit.d/${service}`;
    try {
      const conf = readVfsText(fs, path).replace(/^logfile\s*=.*\n/gm, "");
      writeVfsFile(fs, path, conf);
    } catch {
      // Some service images do not include every optional service.
    }
  }
}

export function configureWordPressRuntime(
  fs: MemoryFileSystem,
  options: { port: number; freshSqliteDatabase?: boolean; phpFpmWorkers?: number },
): void {
  rewriteNginxListenPort(fs, options.port);

  try {
    const phpFpmConf = readVfsText(fs, "/etc/php-fpm.conf")
      .replace(/pm\.max_children\s*=\s*\d+/, `pm.max_children = ${options.phpFpmWorkers ?? 6}`);
    writeVfsFile(fs, "/etc/php-fpm.conf", phpFpmConf);
  } catch {
    // Not every service image has PHP-FPM.
  }

  try {
    const wpConfig = readVfsText(fs, "/etc/wp-config-template.php")
      .replaceAll("@@APP_PATH@@", "/")
      .replaceAll("@@PROTO@@", "http");
    writeVfsFile(fs, "/var/www/html/wp-config.php", wpConfig);
  } catch {
    // Not every web service image has WordPress.
  }

  try {
    writeVfsFile(
      fs,
      "/etc/wp-config-init.sh",
      "echo \"wp-config-init: APP_PATH=${WP_APP_PATH:-/} PROTO=${WP_PROTO:-http}\"\n",
    );
  } catch {
    // Not every web service image has wp-config-init.
  }

  if (options.freshSqliteDatabase) {
    try {
      fs.unlink("/var/www/html/wp-content/database/wordpress.db");
    } catch {
      // Fresh release images do not contain an installed database.
    }
  }

  ensureDirRecursive(fs, "/var/cache/opcache");
  removeServiceLogfiles(fs, [
    "wp-config-init",
    "smtp-capture",
    "mariadb-bootstrap",
    "mariadb",
    "php-fpm",
    "nginx",
  ]);
}

export async function waitForHttp(url: string, timeoutMs: number, shouldAbort?: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) throw new Error("service exited before HTTP readiness");
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      await resp.body?.cancel();
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for HTTP readiness: ${url}`);
}

export async function waitForTcp(port: number, timeoutMs: number, shouldAbort?: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shouldAbort?.()) throw new Error("service exited before TCP readiness");
    try {
      await connectOnce(port, Math.min(2_000, Math.max(250, deadline - Date.now())));
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Timed out waiting for TCP readiness on 127.0.0.1:${port}`);
}

export function installSignalHandlers(host: NodeKernelHost): void {
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await host.destroy().catch(() => {});
    process.exit(0);
  });
}

export function trackDinitExit(exitPromise: Promise<number>): () => boolean {
  let exited = false;
  exitPromise.then(
    (code) => {
      exited = true;
      console.error(`dinit exited with code ${code}`);
    },
    () => {
      exited = true;
    },
  );
  return () => exited;
}

export async function finishWhenDinitExits(host: NodeKernelHost, exitPromise: Promise<number>): Promise<never> {
  const status = await exitPromise;
  await host.destroy().catch(() => {});
  process.exit(status);
}

function connectOnce(port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(resolve));
    socket.once("timeout", () => finish(() => reject(new Error("timeout"))));
    socket.once("error", (err) => finish(() => reject(err)));
    socket.connect(port, "127.0.0.1");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
