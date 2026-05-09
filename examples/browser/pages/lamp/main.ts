/**
 * WordPress (LAMP) browser demo — boots a service-demo VFS image with
 * dinit as PID 1. dinit chains:
 *
 *   mariadb-bootstrap (scripted) — populates /data via mariadbd --bootstrap
 *   mariadb           (process)  — daemon, listens 127.0.0.1:3306
 *   wp-config-init    (scripted) — sed-substitutes @@APP_PATH@@/@@PROTO@@
 *   php-fpm           (process)  — FastCGI on 127.0.0.1:9000
 *   nginx             (process)  — HTTP on :8080
 *
 * The page passes WP_APP_PATH and WP_PROTO via env so wp-config-init
 * can finalize wp-config.php's runtime values (WP_HOME / WP_SITEURL).
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { initServiceWorkerBridge } from "../../lib/init/service-worker-bridge";
import { HttpBridgeHost } from "../../lib/http-bridge";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { writeVfsFile } from "../../../../host/src/vfs/image-helpers";
import kernelWasmUrl from "@kernel-wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/lamp.vfs.zst?url";
import "../../lib/terminal-panel.css";

// Replacement for /etc/mariadb/bootstrap.sh shipped in lamp.vfs. The
// release-baked script unconditionally `sleep 60`s — the dominant
// boot-time cost (~60s of an ~150s boot, since the rest of dinit's
// chain runs concurrently with bootstrap). This version polls for the
// canonical "bootstrap done" marker (the `wordpress` database
// directory created by the LAST statement in bootstrap.sql) and
// breaks early. Falls back to the original 60s safety cap if the
// marker never lands. Patched in-place at boot to avoid needing a new
// release archive — the next release built from build-lamp-vfs-image.ts
// already has the fix baked in and this patch becomes a no-op.
//
// Also patches nginx.conf to relax fastcgi_read_timeout. The released
// nginx.conf inherits nginx's 60s default, but WordPress install.php
// on this stack legitimately runs longer than that (bcrypt + ~100 SQL
// round-trips against the wasm-emulated MariaDB → mysql client →
// kernel-pipe loopback). The result was a 504 Gateway Time-out shown
// to the user as "WordPress install hangs." Bumping the timeout to
// 10 minutes lets install.php finish naturally.
const PATCHED_NGINX_CONF = `user root;
daemon off;
master_process on;
worker_processes 2;
error_log stderr info;
pid /tmp/nginx.pid;

events {
    worker_connections 64;
    use poll;
}

http {
    client_body_temp_path /tmp/nginx_client_temp;
    fastcgi_temp_path     /tmp/nginx_fastcgi_temp;
    types {
        text/html  html htm;
        text/css   css;
        text/javascript js;
        application/json json;
        image/png  png;
        image/svg+xml svg;
    }
    default_type application/octet-stream;

    fastcgi_read_timeout 600;
    fastcgi_send_timeout 600;
    proxy_read_timeout 600;

    server {
        listen 8080;
        server_name localhost;
        root /var/www/html;
        index index.html;

        location /wp-includes/css/ { }
        location /wp-includes/js/ { }
        location /wp-includes/fonts/ { }
        location /wp-includes/images/ { }
        location /wp-admin/css/ { }
        location /wp-admin/js/ { }
        location /wp-admin/images/ { }
        location /wp-content/ {
            try_files $uri @fpm;
        }
        location @fpm {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_param SCRIPT_FILENAME /var/www/fpm-router.php;
            fastcgi_param DOCUMENT_ROOT $document_root;
            fastcgi_param DOCUMENT_URI $document_uri;
            fastcgi_param QUERY_STRING $query_string;
            fastcgi_param REQUEST_METHOD $request_method;
            fastcgi_param CONTENT_TYPE $content_type;
            fastcgi_param CONTENT_LENGTH $content_length;
            fastcgi_param REQUEST_URI $request_uri;
            fastcgi_param SERVER_PROTOCOL $server_protocol;
            fastcgi_param SERVER_PORT $server_port;
            fastcgi_param SERVER_NAME $server_name;
            fastcgi_param HTTP_HOST $http_host;
            fastcgi_param REDIRECT_STATUS 200;
        }
        location / {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_param SCRIPT_FILENAME /var/www/fpm-router.php;
            fastcgi_param DOCUMENT_ROOT $document_root;
            fastcgi_param DOCUMENT_URI $document_uri;
            fastcgi_param QUERY_STRING $query_string;
            fastcgi_param REQUEST_METHOD $request_method;
            fastcgi_param CONTENT_TYPE $content_type;
            fastcgi_param CONTENT_LENGTH $content_length;
            fastcgi_param REQUEST_URI $request_uri;
            fastcgi_param SERVER_PROTOCOL $server_protocol;
            fastcgi_param SERVER_PORT $server_port;
            fastcgi_param SERVER_NAME $server_name;
            fastcgi_param HTTP_HOST $http_host;
            fastcgi_param REDIRECT_STATUS 200;
        }
    }
}
`;

const PATCHED_BOOTSTRAP_SH = `# mariadbd --bootstrap doesn't exit at stdin EOF in our wasm port.
/usr/sbin/mariadbd --no-defaults --user=mysql --datadir=/data --tmpdir=/data/tmp \\
    --default-storage-engine=Aria --skip-grant-tables \\
    --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 \\
    --bootstrap --skip-networking --log-warnings=0 \\
    --log-error=/data/bootstrap.log < /etc/mariadb/bootstrap.sql &
PID=$!
i=0
while [ $i -lt 60 ]; do
    if [ -d /data/wordpress ]; then
        sleep 1
        break
    fi
    sleep 1
    i=$((i + 1))
done
kill -TERM $PID 2>/dev/null
sleep 1
kill -KILL $PID 2>/dev/null
exit 0
`;

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
const APP_PATH = import.meta.env.BASE_URL + "app";
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";
const HTTP_PORT = 8080;

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const reloadBtn = document.getElementById("reload") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
let frame = document.getElementById("frame") as HTMLIFrameElement;

const decoder = new TextDecoder();

let kernel: BrowserKernel | null = null;
let bridgeHttpPort: number | null = null;

function appendLog(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

function setStatus(text: string, type: "loading" | "running" | "error") {
  statusDiv.style.display = "block";
  statusDiv.textContent = text;
  statusDiv.className = `status ${type}`;
}

function loadFrame() {
  const next = document.createElement("iframe");
  next.id = "frame";
  next.src = APP_PREFIX;
  frame.replaceWith(next);
  frame = next;
}

function setupBridgeRestoreListener() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "need-bridge") return;
    const replyPort = event.ports[0];
    if (!replyPort) return;
    const bridge = new HttpBridgeHost();
    replyPort.postMessage(
      { type: "bridge-restored", appPrefix: APP_PREFIX },
      [bridge.getSwPort()],
    );
    if (kernel && bridgeHttpPort != null) {
      kernel.sendBridgePort(bridge.detachHostPort(), bridgeHttpPort);
    }
    appendLog("Bridge restored after service worker restart\n", "info");
  });
}

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading WordPress (LAMP)...", "loading");

  try {
    appendLog("Fetching kernel + VFS image...\n", "info");
    const [kernelBytes, vfsImageBuf] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(VFS_IMAGE_URL).then((r) => {
        if (!r.ok) {
          throw new Error(
            `Failed to load VFS image from ${VFS_IMAGE_URL} (${r.status}). ` +
            `Run: bash examples/browser/scripts/build-lamp-vfs-image.sh`,
          );
        }
        return r.arrayBuffer();
      }),
    ]);
    const rawVfsImage = new Uint8Array(vfsImageBuf);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `VFS: ${(rawVfsImage.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    // Patch the released VFS so existing binaries-abi-v7 lamp.vfs gets
    // both fixes without a new release:
    //   - bootstrap.sh: marker-based wait, ~60s shaved off boot.
    //   - nginx.conf:   relaxed fastcgi_read_timeout, fixes the 504
    //                   Gateway Time-out during WordPress install.
    // The next published lamp.vfs (built from the updated
    // build-lamp-vfs-image.ts) already contains both fixes, in which
    // case these writes just re-write the same bytes.
    const fs = MemoryFileSystem.fromImage(rawVfsImage, {
      maxByteLength: 512 * 1024 * 1024,
    });
    writeVfsFile(fs, "/etc/mariadb/bootstrap.sh", PATCHED_BOOTSTRAP_SH);
    writeVfsFile(fs, "/etc/nginx/nginx.conf", PATCHED_NGINX_CONF);
    const vfsImage = await fs.saveImage();

    appendLog("Initializing service worker bridge...\n", "info");
    const swBridge = await initServiceWorkerBridge(SW_URL, APP_PREFIX);
    if (!swBridge) {
      throw new Error("Service workers unavailable — HTTP bridge not initialized");
    }

    setStatus("Booting kernel with /sbin/dinit...", "loading");
    // Track which ports are listening so we only load the iframe once
    // BOTH nginx (8080) and mariadbd (3306) are accepting connections —
    // dinit considers a `process` service started right after exec(),
    // racing the daemon's actual port-bind by ~10s for mariadbd.
    // Also gate on bridgeSent — see nginx/main.ts for the bridge-vs-listen
    // race rationale (mariadb's slow boot usually masks it here, but be
    // explicit anyway).
    const seenPorts = new Set<number>();
    const REQUIRED_PORTS = [HTTP_PORT, 3306];
    let bridgeSent = false;
    const tryLoadFrame = async () => {
      const allReady = REQUIRED_PORTS.every((p) => seenPorts.has(p));
      if (allReady && bridgeSent && reloadBtn.disabled) {
        setStatus("WordPress running! Loading page...", "running");
        reloadBtn.disabled = false;

        // DIAGNOSTIC: time individual MariaDB queries directly via the
        // page-side MySQL client, *without* PHP/WordPress in the path.
        // If a `SELECT 1` already takes seconds, the cost is mariadbd's
        // per-query work. If it's instant, the cost is upstream
        // (PHP/WP).
        try {
          const { MySqlBrowserClient } = await import("../../lib/mysql-client");
          appendLog("\n[probe] connecting page-side mysql client...\n", "info");
          const t0 = performance.now();
          const client = await MySqlBrowserClient.connect(kernel!, 3306);
          appendLog(`[probe] connect: ${(performance.now() - t0).toFixed(0)} ms\n`, "info");

          const queries = [
            "SELECT 1",
            "SELECT VERSION()",
            "SHOW DATABASES",
            "SHOW TABLES FROM wordpress",
            "SELECT 1",      // repeat to measure warm-cache cost
            "SHOW VARIABLES LIKE 'aria%'",
          ];
          for (const q of queries) {
            const t = performance.now();
            try {
              await client.query(q);
              appendLog(`[probe] ${q}: ${(performance.now() - t).toFixed(0)} ms\n`, "info");
            } catch (e: any) {
              appendLog(`[probe] ${q}: ERROR ${e?.message ?? e}\n`, "stderr");
            }
          }
          client.close();
        } catch (e: any) {
          appendLog(`[probe] page-side mysql failed: ${e?.message ?? e}\n`, "stderr");
        }

        loadFrame();
      }
    };

    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 16,
      // No maxMemoryPages cap — mariadbd's Aria recovery needs ~130 MiB
      // allocations during InnoDB+Aria startup, which spilled past the
      // 256 MiB cap (4096 pages) the wordpress demo uses. Default is
      // 16384 pages (1 GiB) which is plenty.
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
      onListenTcp: (_pid, _fd, port) => {
        appendLog(`service listening on :${port}\n`, "info");
        seenPorts.add(port);
        tryLoadFrame();
      },
    });

    const { exit } = await kernel.boot({
      kernelWasm: kernelBytes,
      vfsImage,
      argv: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl"],
      env: [
        "HOME=/root",
        "TERM=xterm-256color",
        "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
        `WP_APP_PATH=${APP_PATH}`,
        `WP_PROTO=${PROTO}`,
      ],
    });

    kernel.sendBridgePort(swBridge.detachHostPort(), HTTP_PORT);
    bridgeHttpPort = HTTP_PORT;
    appendLog(`HTTP bridge ready on port ${HTTP_PORT}\n`, "info");
    setupBridgeRestoreListener();
    bridgeSent = true;
    tryLoadFrame();

    const code = await exit;
    appendLog(`\ndinit exited with code ${code}\n`, "info");
    setStatus(`dinit exited with code ${code}`, "error");
  } catch (e: any) {
    const msg = e?.message || String(e);
    setStatus(`Error: ${msg}`, "error");
    appendLog(`Error: ${msg}\n`, "stderr");
    console.error(e);
    startBtn.disabled = false;
  }
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
