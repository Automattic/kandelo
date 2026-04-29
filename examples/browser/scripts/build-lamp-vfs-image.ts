/**
 * Build a fully-bootable VFS image for the WordPress + MariaDB (LAMP)
 * browser demo. dinit (PID 1) brings up the full stack:
 *
 *   mariadb-bootstrap (scripted) — wraps `mariadbd --bootstrap < SQL`
 *                                  with a sleep+kill timeout because
 *                                  mariadbd doesn't exit at stdin EOF.
 *   mariadb           (process)  — depends-on mariadb-bootstrap
 *   wp-config-init    (scripted) — substitutes @@APP_PATH@@/@@PROTO@@
 *                                  in /etc/wp-config-template.php from
 *                                  env vars passed via kernel.boot().
 *   php-fpm           (process)  — depends-on mariadb, wp-config-init
 *   nginx             (process)  — depends-on php-fpm
 *
 * Produces: examples/browser/public/lamp.vfs
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

const REPO_ROOT = findRepoRoot();
const BROWSER_DIR = join(REPO_ROOT, "examples", "browser");
const WP_DIR = join(REPO_ROOT, "examples", "wordpress", "wordpress");
const MARIADB_INSTALL = join(REPO_ROOT, "examples", "libs", "mariadb", "mariadb-install");
const MARIADB_PATH = join(MARIADB_INSTALL, "bin", "mariadbd.wasm");
const SYSTEM_TABLES_PATH = join(MARIADB_INSTALL, "share", "mysql", "mysql_system_tables.sql");
const SYSTEM_DATA_PATH = join(MARIADB_INSTALL, "share", "mysql", "mysql_system_tables_data.sql");
const DASH_PATH = resolveBinary("programs/dash.wasm");
const NGINX_PATH = resolveBinary("programs/nginx.wasm");
const PHP_FPM_PATH = resolveBinary("programs/php/php-fpm.wasm");
const COREUTILS_PATH = resolveBinary("programs/coreutils.wasm");
const SED_PATH = resolveBinary("programs/sed.wasm");
const OUT_FILE = join(BROWSER_DIR, "public", "lamp.vfs");

function populateSystem(fs: MemoryFileSystem): void {
  for (const dir of [
    "/tmp", "/home", "/dev", "/etc", "/bin", "/usr", "/usr/bin",
    "/usr/local", "/usr/local/bin", "/usr/share", "/usr/share/misc",
    "/usr/share/file", "/root", "/usr/sbin",
    "/data", "/data/mysql", "/data/tmp", "/data/test",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);

  // /etc/services for getservbyname/getservbyport
  const services = [
    "ftp\t\t21/tcp", "ssh\t\t22/tcp", "telnet\t\t23/tcp",
    "smtp\t\t25/tcp\t\tmail", "http\t\t80/tcp\t\twww",
    "https\t\t443/tcp", "mysql\t\t3306/tcp",
  ].join("\n") + "\n";
  writeVfsFile(fs, "/etc/services", services);
}

function populateDash(fs: MemoryFileSystem): void {
  writeVfsBinary(fs, "/bin/dash", new Uint8Array(readFileSync(DASH_PATH)));
  symlink(fs, "/bin/dash", "/bin/sh");
  symlink(fs, "/bin/dash", "/usr/bin/dash");
  symlink(fs, "/bin/dash", "/usr/bin/sh");
}

function populateShellSymlinks(fs: MemoryFileSystem): void {
  for (const name of [...COREUTILS_NAMES, "["]) {
    symlink(fs, "/bin/coreutils", `/bin/${name}`);
    symlink(fs, "/bin/coreutils", `/usr/bin/${name}`);
  }
  symlink(fs, "/usr/bin/sed", "/bin/sed");
}

function populateMariadb(fs: MemoryFileSystem): void {
  writeVfsBinary(fs, "/usr/sbin/mariadbd", new Uint8Array(readFileSync(MARIADB_PATH)));
  ensureDirRecursive(fs, "/etc/mariadb");
  const systemTablesSql = readFileSync(SYSTEM_TABLES_PATH, "utf-8");
  const systemDataSql = readFileSync(SYSTEM_DATA_PATH, "utf-8");
  const bootstrapSql = `use mysql;\n${systemTablesSql}\n${systemDataSql}\nCREATE DATABASE IF NOT EXISTS wordpress;\n`;
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);
}

function populateNginxConfig(fs: MemoryFileSystem): void {
  for (const dir of [
    "/etc/nginx", "/var/www/html", "/var/log/nginx",
    "/tmp/nginx_client_temp", "/tmp/nginx_fastcgi_temp",
  ]) ensureDirRecursive(fs, dir);

  const fastcgiParams = `fastcgi_pass 127.0.0.1:9000;
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
            fastcgi_param REDIRECT_STATUS 200;`;

  const nginxConf = `user root;
daemon off;
master_process off;
worker_processes 0;
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
            ${fastcgiParams}
        }
        location / {
            ${fastcgiParams}
        }
    }
}
`;
  writeVfsFile(fs, "/etc/nginx/nginx.conf", nginxConf);
}

function populatePhpFpmConfig(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/etc/php-fpm.d");
  ensureDirRecursive(fs, "/var/log");

  const phpFpmConf = `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
user = nobody
group = nobody
listen = 127.0.0.1:9000
pm = static
pm.max_children = 1
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;
  writeVfsFile(fs, "/etc/php-fpm.conf", phpFpmConf);

  const fpmRouter = `<?php
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$docRoot = $_SERVER['DOCUMENT_ROOT'];
$file = $docRoot . $uri;

$staticTypes = [
    'css' => 'text/css', 'js' => 'text/javascript', 'json' => 'application/json',
    'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg',
    'gif' => 'image/gif', 'svg' => 'image/svg+xml', 'ico' => 'image/x-icon',
    'woff' => 'font/woff', 'woff2' => 'font/woff2', 'ttf' => 'font/ttf',
    'map' => 'application/json', 'xml' => 'application/xml', 'txt' => 'text/plain',
];

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

const MARIADB_BOOTSTRAP_SCRIPT = `# mariadbd --bootstrap doesn't exit at stdin EOF in our wasm port.
# Background it, sleep long enough for the SQL to drain (data files
# written synchronously while mariadbd reads stdin), then kill it.
# **No \`wait\`** — dinit (PID 1) reaps orphans and races with dash's
# wait builtin, which then blocks. Letting dinit reap is fine.
/usr/sbin/mariadbd --no-defaults --user=mysql --datadir=/data --tmpdir=/data/tmp \\
    --default-storage-engine=Aria --skip-grant-tables \\
    --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 \\
    --bootstrap --skip-networking --log-warnings=0 \\
    --log-error=/data/bootstrap.log < /etc/mariadb/bootstrap.sql &
PID=$!
sleep 60
kill -TERM $PID 2>/dev/null
sleep 1
kill -KILL $PID 2>/dev/null
exit 0
`;

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
define('WP_DEBUG_DISPLAY', false);
@ini_set('display_errors', '0');

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

function buildServices(): DinitService[] {
  return [
    {
      name: "mariadb-bootstrap",
      type: "scripted",
      command: "/bin/sh /etc/mariadb/bootstrap.sh",
      logfile: "/var/log/mariadb-bootstrap.log",
      restart: false,
    },
    {
      name: "mariadb",
      type: "process",
      command: "/usr/sbin/mariadbd --no-defaults --user=mysql " +
        "--datadir=/data --tmpdir=/data/tmp --default-storage-engine=Aria " +
        "--skip-grant-tables --key-buffer-size=1048576 --table-open-cache=10 " +
        "--sort-buffer-size=262144 --skip-networking=0 --port=3306 " +
        "--bind-address=0.0.0.0 --socket= --max-connections=10 " +
        "--thread-handling=no-threads --log-error=/data/error.log " +
        // --init-file runs after the daemon is ready — guarantees the
        // wordpress DB exists even if the bootstrap timeout-and-kill
        // truncated the original CREATE DATABASE.
        "--init-file=/etc/mariadb/init.sql",
      dependsOn: ["mariadb-bootstrap"],
      logfile: "/var/log/mariadb.log",
      restart: false,
    },
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
      command: "/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize",
      dependsOn: ["mariadb", "wp-config-init"],
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

async function main() {
  try { lstatSync(join(WP_DIR, "wp-settings.php")); }
  catch { console.error("WordPress not found. Run: bash examples/wordpress/setup.sh"); process.exit(1); }
  try { lstatSync(MARIADB_PATH); }
  catch { console.error("mariadbd.wasm not found. Run: bash examples/libs/mariadb/build-mariadb.sh"); process.exit(1); }

  // 256 MiB initial — WordPress core + SQLite plugin (~80 MiB) + MariaDB
  // binary (~14 MiB) + bootstrap SQL (~1 MiB) plus headroom. Worker entry
  // makes the SAB growable to 1 GiB so InnoDB's allocations and table
  // data can expand at runtime.
  const sab = new SharedArrayBuffer(256 * 1024 * 1024, { maxByteLength: 512 * 1024 * 1024 });
  const fs = MemoryFileSystem.create(sab, 512 * 1024 * 1024);

  console.log("Populating system + binaries...");
  populateSystem(fs);
  populateDash(fs);

  console.log("Writing server binaries...");
  writeVfsBinary(fs, "/usr/sbin/nginx", new Uint8Array(readFileSync(NGINX_PATH)));
  writeVfsBinary(fs, "/usr/sbin/php-fpm", new Uint8Array(readFileSync(PHP_FPM_PATH)));
  writeVfsBinary(fs, "/bin/coreutils", new Uint8Array(readFileSync(COREUTILS_PATH)));
  writeVfsBinary(fs, "/usr/bin/sed", new Uint8Array(readFileSync(SED_PATH)));
  populateShellSymlinks(fs);

  console.log("Writing MariaDB binary + bootstrap SQL...");
  populateMariadb(fs);

  populateNginxConfig(fs);
  populatePhpFpmConfig(fs);

  // Bootstrap + config-init scripts (sed-substituted at boot from env).
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sh", MARIADB_BOOTSTRAP_SCRIPT);
  // mariadbd --init-file runs at server startup — used as a belt-and-
  // suspenders guarantee that the wordpress DB exists, since the
  // bootstrap timeout-and-kill might truncate the original
  // CREATE DATABASE during system-table replay.
  writeVfsFile(fs, "/etc/mariadb/init.sql", "CREATE DATABASE IF NOT EXISTS wordpress;\n");
  writeVfsFile(fs, "/etc/wp-config-template.php", WP_CONFIG_TEMPLATE_PHP);
  writeVfsFile(fs, "/etc/wp-config-init.sh", WP_CONFIG_INIT_SCRIPT);

  // WordPress-specific dirs + mu-plugin
  ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");
  const muPlugin = `<?php
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function($pre, $args, $url) {
    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
}, 10, 3);
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;
  writeVfsFile(fs, "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php", muPlugin);

  console.log("Writing WordPress core files...");
  const excludeDb = (rel: string) => rel.endsWith(".db") || rel.includes("wp-content/db.php");
  const wpCount = walkAndWrite(fs, WP_DIR, "/var/www/html", { exclude: excludeDb });
  console.log(`  WordPress core: ${wpCount} files`);

  // Service tree
  addDinitInit(fs, buildServices());

  await saveImage(fs, OUT_FILE);
  console.log(`${wpCount} WordPress files total`);
}

main().catch((err) => { console.error(err); process.exit(1); });
