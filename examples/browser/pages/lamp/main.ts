/**
 * Full LAMP stack browser demo — MariaDB + PHP-FPM + nginx + WordPress.
 *
 * Uses SystemInit to orchestrate boot from /etc/init.d/ service descriptors.
 *
 * Process layout:
 *   pid 1: mariadbd --bootstrap (oneshot, terminated after stdin consumed)
 *   pid 2: mariadbd server (daemon, spawns 5 background threads)
 *   pid N: php-fpm master -> forks worker
 *   pid N: nginx master   -> forks workers
 *   pid N: dash -i (interactive shell with PTY)
 *
 * MariaDB listens on 127.0.0.1:3306, PHP-FPM on 127.0.0.1:9000,
 * nginx on 127.0.0.1:8080. All inter-process communication flows
 * through the kernel's loopback TCP.
 *
 * Service worker intercepts ${BASE_URL}app/* requests and routes them to nginx.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { SystemInit } from "../../lib/init/system-init";
import { populateNginxConfig } from "../../lib/init/nginx-config";
import { populatePhpFpmConfig } from "../../lib/init/php-fpm-config";
import { populateMariadbDirs } from "../../lib/init/mariadb-config";
import {
  populateShellBinaries,
  type BinaryDef,
  COREUTILS_NAMES,
} from "../../lib/init/shell-binaries";
import {
  writeVfsBinary,
  writeVfsFile,
  writeInitDescriptor,
  ensureDir,
  ensureDirRecursive,
} from "../../lib/init/vfs-utils";
import { loadWordPressBundle } from "../../lib/wp-bundle";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import mariadbWasmUrl from "../../../../examples/libs/mariadb/mariadb-install/bin/mariadbd.wasm?url";
import nginxWasmUrl from "../../../../examples/nginx/nginx.wasm?url";
import phpFpmWasmUrl from "../../../../examples/nginx/php-fpm.wasm?url";
import systemTablesUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql?url";
import systemDataUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql?url";
import dashWasmUrl from "../../../../examples/libs/dash/bin/dash.wasm?url";
import coreutilsWasmUrl from "../../../../examples/libs/coreutils/bin/coreutils.wasm?url";
import grepWasmUrl from "../../../../examples/libs/grep/bin/grep.wasm?url";
import sedWasmUrl from "../../../../examples/libs/sed/bin/sed.wasm?url";
import "@xterm/xterm/css/xterm.css";
import "../../lib/terminal-panel.css";

const APP_PREFIX = import.meta.env.BASE_URL + "app/";
// Without trailing slash, for embedding in PHP config strings
const APP_PATH = import.meta.env.BASE_URL + "app";
// Capture the real page protocol so wp-config.php generates correct URLs
const PROTO = window.location.protocol === "https:" ? "https" : "http";
const SW_URL = import.meta.env.BASE_URL + "service-worker.js";

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const reloadBtn = document.getElementById("reload") as HTMLButtonElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const terminalPanel = document.getElementById("terminal-panel") as HTMLDivElement;
let frame = document.getElementById("frame") as HTMLIFrameElement;

const decoder = new TextDecoder();

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

/** FastCGI location block — routes ALL requests through the FPM router. */
const FASTCGI_LOCATION = `        location / {
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
        }`;

// WordPress wp-config.php for MySQL/MariaDB
const WP_CONFIG_PHP = `<?php
define('DB_NAME', 'wordpress');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', '127.0.0.1:3306');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

define('AUTH_KEY',         'wasm-posix-kernel-lamp');
define('SECURE_AUTH_KEY',  'wasm-posix-kernel-lamp');
define('LOGGED_IN_KEY',    'wasm-posix-kernel-lamp');
define('NONCE_KEY',        'wasm-posix-kernel-lamp');
define('AUTH_SALT',        'wasm-posix-kernel-lamp');
define('SECURE_AUTH_SALT', 'wasm-posix-kernel-lamp');
define('LOGGED_IN_SALT',   'wasm-posix-kernel-lamp');
define('NONCE_SALT',       'wasm-posix-kernel-lamp');

$table_prefix = 'wp_';

define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', true);

if (isset($_SERVER['HTTP_HOST'])) {
    if ('${PROTO}' === 'https') { $_SERVER['HTTPS'] = 'on'; }
    define('WP_HOME', '${PROTO}://' . $_SERVER['HTTP_HOST'] . '${APP_PATH}');
    define('WP_SITEURL', '${PROTO}://' . $_SERVER['HTTP_HOST'] . '${APP_PATH}');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`;

// mu-plugin to disable operations that hang or are unnecessary in Wasm
const MU_PLUGIN_PHP = `<?php
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function($pre, $args, $url) {
    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
}, 10, 3);
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;

/** Fetch file size via HEAD request. Returns 0 on failure. */
async function fetchSize(url: string): Promise<number> {
  try {
    const resp = await fetch(url, { method: "HEAD" });
    if (!resp.ok) return 0;
    return parseInt(resp.headers.get("content-length") || "0", 10) || 0;
  } catch {
    return 0;
  }
}

let kernel: BrowserKernel | null = null;
let init: SystemInit | null = null;

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading LAMP stack...", "loading");

  try {
    // Fetch kernel, MariaDB (eager — written to VFS), dash, and bootstrap SQL
    appendLog("Fetching resources...\n", "info");
    const [kernelBytes, mariadbBytes, dashBytes, systemTablesSql, systemDataSql, nginxSize, phpFpmSize] =
      await Promise.all([
        fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
        fetch(mariadbWasmUrl).then((r) => r.arrayBuffer()),
        fetch(dashWasmUrl).then((r) => r.arrayBuffer()),
        fetch(systemTablesUrl).then((r) => r.text()),
        fetch(systemDataUrl).then((r) => r.text()),
        fetchSize(nginxWasmUrl),
        fetchSize(phpFpmWasmUrl),
      ]);

    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
        `MariaDB: ${(mariadbBytes.byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
        `dash: ${(dashBytes.byteLength / 1024).toFixed(0)}KB, ` +
        `nginx: ${(nginxSize / (1024 * 1024)).toFixed(1)}MB (lazy), ` +
        `PHP-FPM: ${(phpFpmSize / (1024 * 1024)).toFixed(1)}MB (lazy)\n`,
      "info",
    );

    // Fetch sizes for shell utility binaries
    const lazyDefs = [
      { url: coreutilsWasmUrl, path: "/bin/coreutils", symlinks: [...COREUTILS_NAMES, "["].flatMap(n => [`/bin/${n}`, `/usr/bin/${n}`]) },
      { url: grepWasmUrl, path: "/usr/bin/grep", symlinks: ["/bin/grep", "/usr/bin/egrep", "/bin/egrep", "/usr/bin/fgrep", "/bin/fgrep"] },
      { url: sedWasmUrl, path: "/usr/bin/sed", symlinks: ["/bin/sed"] },
    ];
    const sizes = await Promise.all(lazyDefs.map((d) => fetchSize(d.url)));
    const lazyBinaries: BinaryDef[] = [];
    for (let i = 0; i < lazyDefs.length; i++) {
      if (sizes[i] > 0) {
        lazyBinaries.push({ ...lazyDefs[i], size: sizes[i] });
      }
    }

    // Create kernel — thread module is auto-compiled on first clone()
    kernel = new BrowserKernel({
      maxWorkers: 16,
      fsSize: 128 * 1024 * 1024, // 128MB for WordPress bundle + MariaDB data
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => {
        const text = decoder.decode(data);
        appendLog(text, "stderr");
        console.log(`[STDERR] ${text.trim()}`);
      },
    });

    await kernel.init(kernelBytes);

    // Populate VFS
    appendLog("Populating filesystem...\n", "info");
    const fs = kernel.fs;

    // Shell binaries (dash eager, utilities lazy)
    populateShellBinaries(kernel, dashBytes, lazyBinaries);

    // MariaDB binary — write eagerly since we already fetched it
    ensureDir(fs, "/usr/sbin");
    writeVfsBinary(fs, "/usr/sbin/mariadbd", new Uint8Array(mariadbBytes));

    // MariaDB data directories
    populateMariadbDirs(fs);

    // nginx and PHP-FPM as lazy files
    const lazyFiles: Array<{ path: string; url: string; size: number; mode: number }> = [];
    if (nginxSize > 0) {
      lazyFiles.push({ path: "/usr/sbin/nginx", url: nginxWasmUrl, size: nginxSize, mode: 0o755 });
    }
    if (phpFpmSize > 0) {
      lazyFiles.push({ path: "/usr/sbin/php-fpm", url: phpFpmWasmUrl, size: phpFpmSize, mode: 0o755 });
    }
    if (lazyFiles.length > 0) {
      kernel.registerLazyFiles(lazyFiles);
    }

    // nginx config and directories — WordPress routes all requests through FPM router
    populateNginxConfig(fs, {
      extraLocations: FASTCGI_LOCATION,
    });

    // PHP-FPM config and directories
    populatePhpFpmConfig(fs);

    // WordPress-specific directories
    ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");

    // Write the bootstrap SQL to VFS
    const bootstrapSql = `use mysql;\n${systemTablesSql}\n${systemDataSql}\nCREATE DATABASE IF NOT EXISTS wordpress;\n`;
    ensureDir(fs, "/etc/mariadb");
    writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

    // Write init service descriptors
    writeInitDescriptor(fs, "05-mariadb-bootstrap", {
      type: "oneshot",
      command: "/usr/sbin/mariadbd --bootstrap --datadir=/data --tmpdir=/data/tmp --skip-networking --log-error=/data/bootstrap.log",
      stdin: "/etc/mariadb/bootstrap.sql",
      ready: "stdin-consumed",
      terminate: "true",
    });

    writeInitDescriptor(fs, "10-mariadb", {
      type: "daemon",
      command: "/usr/sbin/mariadbd --datadir=/data --tmpdir=/data/tmp --skip-networking=0 --port=3306 --thread-handling=no-threads --skip-grant-tables --default-storage-engine=Aria --log-error=/data/error.log",
      depends: "mariadb-bootstrap",
      ready: "port:3306",
    });

    writeInitDescriptor(fs, "20-php-fpm", {
      type: "daemon",
      command: "/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize",
      depends: "mariadb",
      ready: "delay:3000",
    });

    writeInitDescriptor(fs, "30-nginx", {
      type: "daemon",
      command: "/usr/sbin/nginx -p /etc/nginx -c nginx.conf",
      depends: "php-fpm",
      ready: "delay:2000",
      bridge: "8080",
    });

    writeInitDescriptor(fs, "99-shell", {
      type: "interactive",
      command: "/bin/dash -i",
      env: "TERM=xterm-256color PS1=\\w\\$\\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin",
      pty: "true",
      cwd: "/root",
    });

    // Create SystemInit and boot
    setStatus("Booting system...", "loading");
    init = new SystemInit(kernel, {
      onLog: (msg, level) => appendLog(msg + "\n", level === "info" ? "info" : "stderr"),
      terminalContainer: terminalPanel,
      serviceWorkerUrl: SW_URL,
      appPrefix: APP_PREFIX,
      onBeforeService: async (name) => {
        if (name === "shell") {
          // Load WordPress bundle after daemons are running but before the shell
          setStatus("Loading WordPress files...", "loading");
          const loaded = await loadWordPressBundle(
            kernel!.fs,
            import.meta.env.BASE_URL + "wp-bundle.json",
            (current, total) => {
              if (current % 500 === 0 || current === total) {
                appendLog(`  ${current}/${total} files\n`, "info");
              }
            },
          );
          appendLog(`WordPress loaded: ${loaded} files\n`, "info");

          // Remove SQLite db.php drop-in — the bundle includes it for the WordPress-only
          // demo, but the LAMP demo uses MariaDB via the MySQL wp-config below.
          try { kernel!.fs.unlink("/var/www/html/wp-content/db.php"); } catch { /* not present */ }

          // Overwrite wp-config.php with MySQL version + install mu-plugin
          writeVfsFile(kernel!.fs, "/var/www/html/wp-config.php", WP_CONFIG_PHP);
          writeVfsFile(kernel!.fs, "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php", MU_PLUGIN_PHP);
        }
      },
      onServiceReady: (name) => {
        if (name === "mariadb-bootstrap") {
          appendLog("Bootstrap complete\n", "info");
        }
        if (name === "nginx") {
          setStatus("LAMP stack running! Loading WordPress...", "running");
          reloadBtn.disabled = false;
          loadFrame();
        }
      },
    });

    await init.boot();
  } catch (e: any) {
    const msg = e?.message || String(e);
    appendLog(`\nError: ${msg}\n`, "stderr");
    setStatus(`Error: ${msg}`, "error");
    console.error(e);
    startBtn.disabled = false;
  }
}

function loadFrame() {
  const next = document.createElement("iframe");
  next.id = "frame";
  next.src = APP_PREFIX;
  frame.replaceWith(next);
  frame = next;
}

startBtn.addEventListener("click", start);
reloadBtn.addEventListener("click", loadFrame);
