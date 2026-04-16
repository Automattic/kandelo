/**
 * nginx configuration generation and directory setup.
 *
 * Generates an nginx.conf suitable for the wasm-posix-kernel browser
 * environment and creates the directories nginx expects at startup.
 */
import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { writeVfsFile, ensureDirRecursive } from "./vfs-utils";

export interface NginxConfigOptions {
  /** Port to listen on (default: 8080) */
  port?: number;
  /** Document root path (default: "/var/www/html") */
  root?: string;
  /** Additional location blocks inserted inside the server{} block */
  extraLocations?: string;
  /** Number of worker processes (default: 2) */
  workerProcesses?: number;
}

/**
 * Generate an nginx.conf string from the given options.
 */
function generateNginxConf(options: NginxConfigOptions = {}): string {
  const port = options.port ?? 8080;
  const root = options.root ?? "/var/www/html";
  const workerProcesses = options.workerProcesses ?? 2;
  const extraLocations = options.extraLocations ?? "";

  return `daemon off;
master_process on;
worker_processes ${workerProcesses};
error_log stderr info;
pid /tmp/nginx.pid;

events {
    worker_connections 64;
    use poll;
}

http {
    access_log /dev/stderr;
    client_body_temp_path /tmp/nginx_client_temp;

    types {
        text/html  html htm;
        text/css   css;
        text/javascript js;
        application/json json map;
        application/xml xml;
        text/plain txt;
        image/png png;
        image/jpeg jpg jpeg;
        image/gif gif;
        image/svg+xml svg;
        image/x-icon ico;
        font/woff woff;
        font/woff2 woff2;
        font/ttf ttf;
        application/vnd.ms-fontobject eot;
    }
    default_type application/octet-stream;

    server {
        listen ${port};
        server_name localhost;
        root ${root};
        index index.html;

${extraLocations ? "\n" + extraLocations + "\n" : "        location / {\n        }\n"}    }
}
`;
}

/**
 * Write nginx.conf and create all directories nginx needs at startup.
 */
export function populateNginxConfig(
  fs: MemoryFileSystem,
  options?: NginxConfigOptions,
): void {
  const dirs = [
    "/etc/nginx",
    "/var/www/html",
    "/var/log/nginx",
    "/tmp/nginx_client_temp",
    "/tmp/nginx-wasm/logs",
  ];

  for (const dir of dirs) {
    ensureDirRecursive(fs, dir);
  }

  writeVfsFile(fs, "/etc/nginx/nginx.conf", generateNginxConf(options));
}
