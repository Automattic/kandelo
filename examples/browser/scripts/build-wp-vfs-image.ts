/**
 * Build a pre-built VFS image containing WordPress, system configs, and
 * shell binaries for instant browser demo boot.
 *
 * Produces: examples/browser/public/wordpress.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-wp-vfs-image.ts
 */
import { readFileSync, lstatSync } from "fs";
import { join } from "path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
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

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const BROWSER_DIR = join(SCRIPT_DIR, "..");
const WP_EXAMPLE_DIR = join(BROWSER_DIR, "..", "wordpress");
const WP_DIR = join(WP_EXAMPLE_DIR, "wordpress");
const SQLITE_DIR = join(WP_EXAMPLE_DIR, "sqlite-database-integration");
const DASH_PATH = join(BROWSER_DIR, "..", "libs", "dash", "bin", "dash.wasm");
const OUT_FILE = join(BROWSER_DIR, "public", "wordpress.vfs");

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

  const nginxConf = `daemon off;
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
listen = 127.0.0.1:9000
pm = static
pm.max_children = 1
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

function writeInitDescriptors(fs: MemoryFileSystem): void {
  ensureDir(fs, "/etc");
  ensureDir(fs, "/etc/init.d");

  writeVfsFile(fs, "/etc/init.d/10-php-fpm", [
    "type=daemon",
    "command=/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize",
    "ready=delay:5000",
    "",
  ].join("\n"));

  writeVfsFile(fs, "/etc/init.d/20-nginx", [
    "type=daemon",
    "command=/usr/sbin/nginx -p /etc/nginx -c nginx.conf",
    "depends=php-fpm",
    "ready=port:8080",
    "bridge=8080",
    "",
  ].join("\n"));

  writeVfsFile(fs, "/etc/init.d/99-shell", [
    "type=interactive",
    "command=/bin/dash -i",
    "env=TERM=xterm-256color PS1=\\w\\$\\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin",
    "pty=true",
    "cwd=/root",
    "",
  ].join("\n"));
}

// --- Main ---

async function main() {
  // Validate prerequisites
  try {
    lstatSync(join(WP_DIR, "wp-settings.php"));
  } catch {
    console.error("WordPress not found. Run: bash examples/wordpress/setup.sh");
    process.exit(1);
  }

  try {
    lstatSync(DASH_PATH);
  } catch {
    console.error("dash.wasm not found. Run: bash build.sh");
    process.exit(1);
  }

  // Create a MemoryFileSystem sized for WordPress (~80MB data + SharedFS overhead).
  // 128MB is sufficient. At runtime, fromImage() with maxByteLength creates a
  // growable SAB so the filesystem can expand beyond this initial size.
  const sab = new SharedArrayBuffer(128 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  console.log("Populating system directories and configs...");
  populateSystem(fs);
  populateDash(fs);
  populateShellSymlinks(fs);
  populateNginxConfig(fs);
  populatePhpFpmConfig(fs);
  writeInitDescriptors(fs);

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

  // Save image
  await saveImage(fs, OUT_FILE);
  console.log(`${wpCount} WordPress files total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
