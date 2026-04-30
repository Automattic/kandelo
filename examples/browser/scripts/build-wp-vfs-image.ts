/**
 * Build a fully-bootable VFS image for the WordPress browser demo.
 * dinit (PID 1) brings up:
 *
 *   wp-config-init (scripted) → php-fpm (process) → nginx (process)
 *
 * The wp-config-init service runs sed at boot to substitute the page-
 * supplied @@APP_PATH@@ and @@PROTO@@ values into wp-config.php. The
 * page passes those as env vars when calling kernel.boot(); dinit
 * inherits its env to scripted children.
 *
 * Produces: examples/browser/public/wordpress.vfs
 */
import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { COREUTILS_NAMES } from "../lib/init/shell-binaries";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirRecursive,
  symlink,
  walkAndWrite,
  saveImage,
} from "./vfs-image-helpers";
import { addDinitInit, type DinitService } from "./dinit-image-helpers";
import { ensureSourceExtract, ensureExtract } from "./source-extract-helper";

const REPO_ROOT = findRepoRoot();
const BROWSER_DIR = join(REPO_ROOT, "examples", "browser");
const WP_EXAMPLE_DIR = join(REPO_ROOT, "examples", "wordpress");
// WordPress + SQLite-Database-Integration plugin trees: prefer the local
// `examples/wordpress/setup.sh` outputs if present (back-compat with
// existing local workflows), otherwise download both via
// source-extract-helper. The WP version + sha live in the wordpress
// package's package.toml; the SQLite plugin is a wp.org-hosted zip with
// no package.toml of its own, so its URL+sha are pinned here.
const SQLITE_PLUGIN_VERSION = "2.1.16";
const SQLITE_PLUGIN_URL =
  `https://downloads.wordpress.org/plugin/sqlite-database-integration.${SQLITE_PLUGIN_VERSION}.zip`;
const SQLITE_PLUGIN_SHA256 =
  "ccc69cada05983e6c2dac8c0962b548c437b4c96c00ea41b0e130fc128671391";
const WP_DIR = ensureSourceExtract("wordpress", REPO_ROOT, join(WP_EXAMPLE_DIR, "wordpress"));
const SQLITE_DIR = ensureExtract({
  url: SQLITE_PLUGIN_URL,
  sha256: SQLITE_PLUGIN_SHA256,
  cacheKey: `sqlite-database-integration-${SQLITE_PLUGIN_VERSION}`,
  legacyPath: join(WP_EXAMPLE_DIR, "sqlite-database-integration"),
});
const DASH_PATH = resolveBinary("programs/dash.wasm");
const NGINX_PATH = resolveBinary("programs/nginx.wasm");
const PHP_FPM_PATH = resolveBinary("programs/php/php-fpm.wasm");
const COREUTILS_PATH = resolveBinary("programs/coreutils.wasm");
const SED_PATH = resolveBinary("programs/sed.wasm");
const OUT_FILE = join(BROWSER_DIR, "public", "wordpress.vfs.zst");

// --- System setup (mirrors BrowserKernel constructor + populateShellBinaries) ---

function populateSystem(fs: MemoryFileSystem): void {
  // Standard directories
  for (const dir of [
    "/tmp", "/home", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/local", "/usr/local/bin", "/usr/share", "/usr/share/misc",
    "/usr/share/file", "/root", "/usr/sbin",
  ]) {
    ensureDir(fs, dir);
  }
  // /tmp needs 0o777
  fs.chmod("/tmp", 0o777);

  // /etc/services for getservbyname/getservbyport
  const services = [
    "tcpmux\t\t1/tcp",
    "echo\t\t7/tcp",
    "echo\t\t7/udp",
    "discard\t\t9/tcp\t\tsink null",
    "discard\t\t9/udp\t\tsink null",
    "ftp-data\t20/tcp",
    "ftp\t\t21/tcp",
    "ssh\t\t22/tcp",
    "telnet\t\t23/tcp",
    "smtp\t\t25/tcp\t\tmail",
    "domain\t\t53/tcp",
    "domain\t\t53/udp",
    "http\t\t80/tcp\t\twww",
    "pop3\t\t110/tcp\t\tpop-3",
    "nntp\t\t119/tcp\t\treadnews untp",
    "ntp\t\t123/udp",
    "imap\t\t143/tcp\t\timap2",
    "snmp\t\t161/udp",
    "https\t\t443/tcp",
    "imaps\t\t993/tcp",
    "pop3s\t\t995/tcp",
  ].join("\n") + "\n";
  writeVfsFile(fs, "/etc/services", services);

  // Git config
  const gitconfig = [
    "[maintenance]",
    "\tauto = false",
    "[gc]",
    "\tauto = 0",
    "[core]",
    "\tpager = cat",
    "[user]",
    "\tname = User",
    "\temail = user@wasm.local",
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
  writeVfsFile(fs, "/etc/gitconfig", gitconfig);
}

function populateDash(fs: MemoryFileSystem): void {
  const dashBytes = readFileSync(DASH_PATH);
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(dashBytes));
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  symlink(fs, "/bin/dash", "/usr/bin/sh");
}

function populateShellSymlinks(fs: MemoryFileSystem): void {
  // Coreutils symlinks — target stubs don't need to exist, symlink target
  // is just a stored path string. The actual binary is registered lazily at runtime.
  for (const name of [...COREUTILS_NAMES, "["]) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }

  // grep symlinks
  symlink(fs, "/usr/bin/grep", "/bin/grep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/bin/egrep");
  symlink(fs, "/usr/bin/grep", "/usr/bin/fgrep");
  symlink(fs, "/usr/bin/grep", "/bin/fgrep");

  // sed symlinks
  symlink(fs, "/usr/bin/sed", "/bin/sed");
}

// --- Service configs (reuse logic from init modules) ---

function populateNginxConfig(fs: MemoryFileSystem): void {
  const dirs = [
    "/etc/nginx", "/var/www/html", "/var/log/nginx",
    "/tmp/nginx_client_temp", "/tmp/nginx-wasm/logs",
  ];
  for (const dir of dirs) ensureDirRecursive(fs, dir);

  // WordPress FastCGI location block — static asset directories are served
  // directly by nginx (no PHP-FPM overhead). Everything else goes through the
  // FPM router which handles directory index resolution, PHP execution, and
  // the front controller fallback for pretty URLs.
  const extraLocations = `        # Static asset directories — served directly by nginx
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

        # Everything else through PHP-FPM (PHP pages, front controller)
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
        }`;

  const nginxConf = `user root;
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
    access_log /dev/stderr;
    client_body_temp_path /tmp/nginx_client_temp;

    types {
        text/html  html htm;
        text/css   css;
        text/javascript js;
        application/json json;
        image/png png;
        image/svg+xml svg;
    }
    default_type application/octet-stream;

    server {
        listen 8080;
        server_name localhost;
        root /var/www/html;
        index index.html;

${extraLocations}
    }
}
`;

  writeVfsFile(fs, "/etc/nginx/nginx.conf", nginxConf);
}

function populatePhpFpmConfig(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/etc/php-fpm.d");
  ensureDirRecursive(fs, "/var/log");
  ensureDirRecursive(fs, "/tmp/nginx_fastcgi_temp");

  const phpFpmConf = `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
user = nobody
group = nobody
listen = 127.0.0.1:9000
pm = static
pm.max_children = 2
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;

  writeVfsFile(fs, "/etc/php-fpm.conf", phpFpmConf);

  // FPM router script
  const fpmRouter = `<?php
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$docRoot = $_SERVER['DOCUMENT_ROOT'];
$file = $docRoot . $uri;

$staticTypes = [
    'css'   => 'text/css',
    'js'    => 'text/javascript',
    'json'  => 'application/json',
    'png'   => 'image/png',
    'jpg'   => 'image/jpeg',
    'jpeg'  => 'image/jpeg',
    'gif'   => 'image/gif',
    'svg'   => 'image/svg+xml',
    'ico'   => 'image/x-icon',
    'woff'  => 'font/woff',
    'woff2' => 'font/woff2',
    'ttf'   => 'font/ttf',
    'eot'   => 'application/vnd.ms-fontobject',
    'map'   => 'application/json',
    'xml'   => 'application/xml',
    'txt'   => 'text/plain',
];

// Resolve directory URLs to index.php (e.g. /wp-admin/ -> /wp-admin/index.php)
if (is_dir($file)) {
    $idx = rtrim($file, '/') . '/index.php';
    if (is_file($idx)) {
        $file = $idx;
        $uri = rtrim($uri, '/') . '/index.php';
    }
}

if ($uri !== '/' && is_file($file)) {
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    if (isset($staticTypes[$ext])) {
        header('Content-Type: ' . $staticTypes[$ext]);
        header('Content-Length: ' . filesize($file));
        readfile($file);
        exit;
    }
    if ($ext === 'php') {
        chdir(dirname($file));
        include $file;
        exit;
    }
}

chdir($docRoot);
include $docRoot . '/index.php';
`;
  ensureDirRecursive(fs, "/var/www");
  writeVfsFile(fs, "/var/www/fpm-router.php", fpmRouter);
}

/**
 * dinit service tree:
 *   wp-config-init (scripted) — sed-substitutes @@APP_PATH@@ / @@PROTO@@
 *                               in /var/www/html/wp-config.php from env vars
 *                               passed by the page through dinit.
 *   php-fpm        (process)  — depends-on wp-config-init
 *   nginx          (process)  — depends-on php-fpm
 */
function buildServices(): DinitService[] {
  return [
    {
      name: "wp-config-init",
      type: "scripted",
      command: "/bin/sh /etc/wp-config-init.sh",
      logfile: "/var/log/wp-config-init.log",
      restart: false,
    },
    {
      name: "php-fpm",
      type: "process",
      // -c /dev/null suppresses default php.ini lookup (which lands on
      // /usr/local/lib/php/php.ini-development by default and trips
      // unsupported-config errors on our wasm port).
      command: "/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize",
      dependsOn: ["wp-config-init"],
      logfile: "/var/log/php-fpm.log",
      restart: false,
    },
    {
      name: "nginx",
      type: "process",
      command: "/usr/sbin/nginx -c /etc/nginx/nginx.conf",
      dependsOn: ["php-fpm"],
      logfile: "/var/log/nginx.log",
      restart: false,
    },
  ];
}

const WP_CONFIG_INIT_SCRIPT = `# Substitute runtime values into wp-config.php. WP_APP_PATH and WP_PROTO
# come from the env the page passes through kernel.boot() — dinit
# inherits its env to scripted services.
: "\${WP_APP_PATH:=/app}"
: "\${WP_PROTO:=http}"
sed -e "s|@@APP_PATH@@|$WP_APP_PATH|g" \\
    -e "s|@@PROTO@@|$WP_PROTO|g" \\
    /etc/wp-config-template.php > /var/www/html/wp-config.php
echo "wp-config-init: APP_PATH=$WP_APP_PATH PROTO=$WP_PROTO"
`;

const WP_CONFIG_TEMPLATE_PHP = `<?php
define('DB_NAME', 'wordpress');
define('DB_USER', '');
define('DB_PASSWORD', '');
define('DB_HOST', '');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');

define('DB_DIR', __DIR__ . '/wp-content/database/');
define('DB_FILE', 'wordpress.db');

define('AUTH_KEY',         'wasm-posix-kernel-dev');
define('SECURE_AUTH_KEY',  'wasm-posix-kernel-dev');
define('LOGGED_IN_KEY',    'wasm-posix-kernel-dev');
define('NONCE_KEY',        'wasm-posix-kernel-dev');
define('AUTH_SALT',        'wasm-posix-kernel-dev');
define('SECURE_AUTH_SALT', 'wasm-posix-kernel-dev');
define('LOGGED_IN_SALT',   'wasm-posix-kernel-dev');
define('NONCE_SALT',       'wasm-posix-kernel-dev');

$table_prefix = 'wp_';

define('WP_DEBUG', true);
define('WP_DEBUG_LOG', true);
define('WP_DEBUG_DISPLAY', false);
@ini_set('display_errors', '0');

// Site URL includes app prefix — the service worker intercepts app/*
// and strips it before sending to nginx. @@APP_PATH@@ and @@PROTO@@
// are replaced at boot time by the wp-config-init dinit service.
if (isset($_SERVER['HTTP_HOST'])) {
    if ('@@PROTO@@' === 'https') { $_SERVER['HTTPS'] = 'on'; }
    define('WP_HOME', '@@PROTO@@://' . $_SERVER['HTTP_HOST'] . '@@APP_PATH@@');
    define('WP_SITEURL', '@@PROTO@@://' . $_SERVER['HTTP_HOST'] . '@@APP_PATH@@');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`;

// --- Main ---

async function main() {
  try {
    lstatSync(DASH_PATH);
  } catch {
    console.error("dash.wasm not found. Run: bash build.sh");
    process.exit(1);
  }

  // 128 MiB initial, 256 MiB max growth. WordPress core + SQLite plugin
  // is ~80 MiB. Worker entry then makes the SAB growable to 1 GiB at
  // runtime (mariadbd's InnoDB log lessons).
  const sab = new SharedArrayBuffer(128 * 1024 * 1024, { maxByteLength: 256 * 1024 * 1024 });
  const fs = MemoryFileSystem.create(sab, 256 * 1024 * 1024);

  console.log("Populating system directories and configs...");
  populateSystem(fs);
  populateDash(fs);
  populateShellSymlinks(fs);
  populateNginxConfig(fs);
  populatePhpFpmConfig(fs);

  // Bake server binaries directly — dinit's --container boot path can't
  // lazy-load these, and nginx + php-fpm + coreutils total ~14 MiB
  // (compressed less inside the .vfs).
  console.log("Writing server binaries...");
  writeVfsBinary(fs, "/usr/sbin/nginx", new Uint8Array(readFileSync(NGINX_PATH)));
  writeVfsBinary(fs, "/usr/sbin/php-fpm", new Uint8Array(readFileSync(PHP_FPM_PATH)));
  writeVfsBinary(fs, "/bin/coreutils", new Uint8Array(readFileSync(COREUTILS_PATH)));
  // sed isn't part of coreutils — wp-config-init.sh needs it for the
  // @@APP_PATH@@ / @@PROTO@@ template substitution at boot.
  writeVfsBinary(fs, "/usr/bin/sed", new Uint8Array(readFileSync(SED_PATH)));

  // Template + bootstrap script. wp-config-init service runs the script
  // at boot, sed-substituting @@APP_PATH@@ and @@PROTO@@ from env vars
  // the page passes through dinit's argv/env.
  ensureDirRecursive(fs, "/var/www/html");
  writeVfsFile(fs, "/etc/wp-config-template.php", WP_CONFIG_TEMPLATE_PHP);
  writeVfsFile(fs, "/etc/wp-config-init.sh", WP_CONFIG_INIT_SCRIPT);

  // WordPress-specific directories
  ensureDirRecursive(fs, "/var/www/html/wp-content/database");
  ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");

  // mu-plugin to disable operations that hang in Wasm
  const muPlugin = `<?php
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function($pre, $args, $url) {
    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
}, 10, 3);
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;
  writeVfsFile(fs, "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php", muPlugin);

  // WordPress core files
  const excludeDb = (rel: string) => rel.endsWith(".db");
  console.log("Writing WordPress core files...");
  let wpCount = walkAndWrite(fs, WP_DIR, "/var/www/html", { exclude: excludeDb });
  console.log(`  WordPress core: ${wpCount} files`);

  // SQLite plugin files
  console.log("Writing SQLite plugin files...");
  const sqliteCount = walkAndWrite(
    fs,
    SQLITE_DIR,
    "/var/www/html/wp-content/plugins/sqlite-database-integration",
    { exclude: excludeDb },
  );
  console.log(`  SQLite plugin: ${sqliteCount} files`);
  wpCount += sqliteCount;

  // Drop-in db.php → routes WP_DB_HOST to the SQLite plugin instead of
  // MySQL. setup.sh copies sqlite-database-integration/db.copy into
  // wp-content/db.php; do the same here for the source-extracted path.
  const dbCopy = readFileSync(join(SQLITE_DIR, "db.copy"));
  writeVfsBinary(fs, "/var/www/html/wp-content/db.php", new Uint8Array(dbCopy), 0o644);
  wpCount += 1;

  // dinit + service tree. nginx → php-fpm → wp-config-init dependency
  // chain ensures wp-config.php is finalized before any FastCGI request.
  addDinitInit(fs, buildServices());

  // Save image
  await saveImage(fs, OUT_FILE);
  console.log(`${wpCount} WordPress files total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
