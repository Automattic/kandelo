/**
 * Build a fully-bootable VFS image for the WordPress + MariaDB (LAMP)
 * browser demo. The image starts from shell.vfs.zst, then dinit (PID 1)
 * brings up the full stack:
 *
 *   mariadb           (process)  — starts from a build-time-initialized /data
 *   wp-config-init    (internal) — dependency marker. The browser host writes
 *                                  runtime wp-config.php before dinit starts.
 *   smtp-capture      (process)  — local SMTP sink storing mail under /var/mail
 *   mariadb-ready     (scripted) — waits for the MariaDB socket
 *   php-fpm           (process)  — depends-on mariadb-ready, wp-config-init, smtp-capture
 *   nginx             (process)  — depends-on php-fpm
 *
 * Produces: apps/browser-demos/public/lamp.vfs
 */
import { readFileSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDirRecursive,
  walkAndWrite,
} from "./vfs-image-helpers";
import {
  addDinitInit,
  addPathReadinessService,
  type DinitService,
} from "./dinit-image-helpers";
import { ensureSourceExtract } from "./source-extract-helper";
import { prewarmOpcache } from "./opcache-prewarm";
import {
  webPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";
import {
  WORDPRESS_CONFIG_INIT_SCRIPT,
  patchWordPressMysqliPersistentSource,
  renderWordPressConfig,
  wordpressConfigTemplate,
} from "../../../apps/browser-demos/lib/init/wordpress-runtime-config";
import {
  populateSmtpCaptureConfig,
  smtpCaptureService,
  wordpressSmtpCaptureMuPlugin,
} from "./smtp-capture-helpers";
import { MYSQL_BENCHMARK_PHP } from "../../../apps/browser-demos/lib/init/mysql-benchmark";
import {
  loadShellBaseFileSystem,
  saveShellDerivedVfsImage,
} from "./shell-vfs-build";
import {
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
} from "../../../web-libs/kandelo-session/src/vfs-capacity";
import { preinstallWordPressMariaDb } from "./wordpress-preinstall";
import { prepareMariadbWritableDirectories } from "./mariadb-image-helpers";

const REPO_ROOT = findRepoRoot();
const BROWSER_DIR = join(REPO_ROOT, "apps", "browser-demos");
// WordPress + MariaDB source-tree fallbacks so the demo builds in a
// fetch-only checkout. The mariadbd binary comes from the resolver;
// the system_tables SQL files are shipped only in the upstream MariaDB
// source tarball, so we extract them on demand the same way
// build-mariadb-vfs-image.ts does.
const WP_DIR = ensureSourceExtract(
  "wordpress",
  REPO_ROOT,
  join(REPO_ROOT, "packages", "registry", "wordpress", "wordpress"),
);
const MARIADB_LEGACY_INSTALL = join(REPO_ROOT, "packages", "registry", "mariadb", "mariadb-install");
const MARIADB_SOURCE = ensureSourceExtract("mariadb", REPO_ROOT);
const MARIADB_PATH = resolveBinary("programs/mariadb/mariadbd.wasm");
const SYSTEM_TABLES_PATH = existsSync(join(MARIADB_LEGACY_INSTALL, "share/mysql/mysql_system_tables.sql"))
  ? join(MARIADB_LEGACY_INSTALL, "share/mysql/mysql_system_tables.sql")
  : join(MARIADB_SOURCE, "scripts/mysql_system_tables.sql");
const SYSTEM_DATA_PATH = existsSync(join(MARIADB_LEGACY_INSTALL, "share/mysql/mysql_system_tables_data.sql"))
  ? join(MARIADB_LEGACY_INSTALL, "share/mysql/mysql_system_tables_data.sql")
  : join(MARIADB_SOURCE, "scripts/mysql_system_tables_data.sql");
const NGINX_PATH = resolveBinary("programs/nginx.wasm");
const PHP_FPM_PATH = resolveBinary("programs/php/php-fpm.wasm");
const OPCACHE_SO_PATH = resolveBinary("programs/php/opcache.so");
const MSMTPD_PATH = resolveBinary("programs/msmtpd.wasm");
const OUT_FILE = join(BROWSER_DIR, "public", "lamp.vfs.zst");
const PHP_FPM_WORKERS = 6;
const MARIADB_SOCKET_PATH = "/tmp/mysql.sock";
const LAMP_IMAGE_MAX_BYTES = SHELL_DERIVED_VFS_PROFILE_MAX_BYTES;
const MARIADB_ARIA_LOG_FILE_SIZE = 16 * 1024 * 1024;
const MARIADB_ARIA_PAGECACHE_SIZE = 1024 * 1024;
const MARIADB_INNODB_LOG_FILE_SIZE = 16 * 1024 * 1024;
const MARIADB_INNODB_LOG_BUFFER_SIZE = 1024 * 1024;
const MARIADB_INNODB_BUFFER_POOL_SIZE = 8 * 1024 * 1024;

function populateMariadb(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/usr/sbin");
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
    "/tmp/nginx_client_temp", "/tmp/nginx_fastcgi_temp", "/tmp/nginx_proxy_temp",
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
    proxy_temp_path       /tmp/nginx_proxy_temp;
    types {
        text/html  html htm;
        text/css   css;
        text/javascript js;
        application/json json;
        image/png  png;
        image/svg+xml svg;
    }
    default_type application/octet-stream;

    # WordPress install.php on this stack legitimately runs longer than
    # nginx's 60s default (bcrypt + ~100 SQL round-trips against the
    # wasm-emulated MariaDB → mysql client → kernel-pipe loopback —
    # each round-trip is several ms even on a warm cache). Without the
    # bump, the user sees a 504 Gateway Time-out from nginx and the
    # demo appears hung. 600s is generous; the request itself takes
    # tens of seconds at most on real hardware.
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
pm.max_children = ${PHP_FPM_WORKERS}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;
  writeVfsFile(fs, "/etc/php-fpm.conf", phpFpmConf);

  // opcache: file-cache backend, populated at build time by
  // prewarmOpcache (see end of main()). See build-wp-vfs-image.ts for
  // the rationale — same WordPress codebase, same win.
  ensureDirRecursive(fs, "/usr/lib/php/extensions");
  writeVfsBinary(
    fs,
    "/usr/lib/php/extensions/opcache.so",
    new Uint8Array(readFileSync(OPCACHE_SO_PATH)),
  );
  const phpIni = `zend_extension=/usr/lib/php/extensions/opcache.so

curl.cainfo=/etc/ssl/certs/ca-certificates.crt
openssl.cafile=/etc/ssl/certs/ca-certificates.crt
mysqli.default_socket=${MARIADB_SOCKET_PATH}
pdo_mysql.default_socket=${MARIADB_SOCKET_PATH}

[opcache]
opcache.enable=1
opcache.enable_cli=1
opcache.file_cache=/var/cache/opcache
opcache.file_cache_only=1
opcache.validate_timestamps=0
opcache.blacklist_filename=/etc/php-opcache-blacklist.txt
`;
  writeVfsFile(fs, "/etc/php.ini", phpIni);
  writeVfsFile(
    fs,
    "/etc/php-opcache-blacklist.txt",
    "/var/www/html/wp-includes/SimplePie/autoloader.php\n",
  );

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
# Background it, watch for the canonical "bootstrap done" marker (the
# \`wordpress\` database directory created by the LAST statement in
# bootstrap.sql), then kill mariadbd. Falls back to a 60s safety cap
# if the marker never lands. **No \`wait\`** — dinit (PID 1) reaps
# orphans and races with dash's wait builtin, which then blocks.
# Letting dinit reap is fine.
#
# Polling the marker shaves ~30-50s off boot vs the previous fixed
# 60s sleep — that sleep was the dominant boot-time cost, since the
# rest of dinit's chain runs concurrently with bootstrap.
/usr/sbin/mariadbd --no-defaults --user=mysql --datadir=/data --tmpdir=/data/tmp \\
    --default-storage-engine=Aria --skip-grant-tables \\
    --aria-log-file-size=${MARIADB_ARIA_LOG_FILE_SIZE} \\
    --aria-pagecache-buffer-size=${MARIADB_ARIA_PAGECACHE_SIZE} \\
    --innodb-log-file-size=${MARIADB_INNODB_LOG_FILE_SIZE} \\
    --innodb-log-buffer-size=${MARIADB_INNODB_LOG_BUFFER_SIZE} \\
    --innodb-buffer-pool-size=${MARIADB_INNODB_BUFFER_POOL_SIZE} \\
    --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 \\
    --bootstrap --skip-networking --log-warnings=0 \\
    --log-error=/data/bootstrap.log < /etc/mariadb/bootstrap.sql &
PID=$!
i=0
while [ $i -lt 60 ]; do
    if [ -d /data/wordpress ]; then
        # Marker present — give mariadbd a moment to flush its writes,
        # then tear it down. The persistent mariadb daemon will start
        # fresh on the populated /data and serve normal requests.
        # In build-time preinstall this is the source of the runtime /data
        # image, so prefer the old conservative bootstrap delay over
        # fast-but-dirty crash recovery on the next daemon start.
        sleep 60
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

function buildServices(fs: MemoryFileSystem): DinitService[] {
  const mariadbReady = addPathReadinessService(fs, {
    name: "mariadb-ready",
    path: MARIADB_SOCKET_PATH,
    dependsOn: ["mariadb"],
    label: "MariaDB",
  });

  return [
    {
      name: "mariadb",
      type: "process",
      command: "/usr/sbin/mariadbd --no-defaults --user=mysql " +
        "--datadir=/data --tmpdir=/data/tmp --default-storage-engine=Aria " +
        `--aria-log-file-size=${MARIADB_ARIA_LOG_FILE_SIZE} ` +
        `--aria-pagecache-buffer-size=${MARIADB_ARIA_PAGECACHE_SIZE} ` +
        `--innodb-log-file-size=${MARIADB_INNODB_LOG_FILE_SIZE} ` +
        `--innodb-log-buffer-size=${MARIADB_INNODB_LOG_BUFFER_SIZE} ` +
        `--innodb-buffer-pool-size=${MARIADB_INNODB_BUFFER_POOL_SIZE} ` +
        "--skip-grant-tables --key-buffer-size=1048576 --table-open-cache=10 " +
        "--sort-buffer-size=262144 --skip-networking " +
        `--socket=${MARIADB_SOCKET_PATH} --max-connections=10 ` +
        "--log-error=/data/error.log",
      logfile: "/var/log/mariadb.log",
      restart: false,
    },
    {
      name: "wp-config-init",
      type: "internal",
      restart: false,
    },
    smtpCaptureService(),
    mariadbReady,
    {
      name: "php-fpm",
      type: "process",
      command: "/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /etc/php.ini --nodaemonize",
      dependsOn: ["mariadb-ready", "wp-config-init", "smtp-capture"],
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

const decoder = new TextDecoder();

function patchWordPressPersistentMysqli(fs: MemoryFileSystem): void {
  for (const path of [
    "/var/www/html/wp-includes/class-wpdb.php",
    "/var/www/html/wp-includes/wp-db.php",
  ]) {
    const source = readOptionalVfsText(fs, path);
    if (source === null) continue;
    const patched = patchWordPressMysqliPersistentSource(source);
    if (patched !== source) writeVfsFile(fs, path, patched);
  }
}

function readOptionalVfsText(fs: MemoryFileSystem, path: string): string | null {
  try {
    const st = fs.stat(path);
    const fd = fs.open(path, 0, 0);
    try {
      const out = new Uint8Array(st.size);
      let off = 0;
      while (off < out.byteLength) {
        const n = fs.read(fd, out.subarray(off), null, out.byteLength - off);
        if (n <= 0) break;
        off += n;
      }
      return decoder.decode(out.subarray(0, off));
    } finally {
      fs.close(fd);
    }
  } catch {
    return null;
  }
}

async function main() {
  try { lstatSync(MARIADB_PATH); }
  catch {
    console.error("mariadbd.wasm not found. Run scripts/fetch-binaries.sh or bash packages/registry/mariadb/build-mariadb.sh");
    process.exit(1);
  }

  console.log("Loading shell base image...");
  const fs = loadShellBaseFileSystem(LAMP_IMAGE_MAX_BYTES);
  prepareMariadbWritableDirectories(fs);

  console.log("Writing nginx + php-fpm + msmtpd binaries...");
  ensureDirRecursive(fs, "/usr/sbin");
  writeVfsBinary(fs, "/usr/sbin/nginx", new Uint8Array(readFileSync(NGINX_PATH)));
  writeVfsBinary(fs, "/usr/sbin/php-fpm", new Uint8Array(readFileSync(PHP_FPM_PATH)));
  writeVfsBinary(fs, "/usr/sbin/msmtpd", new Uint8Array(readFileSync(MSMTPD_PATH)));

  console.log("Writing MariaDB binary + bootstrap SQL...");
  populateMariadb(fs);

  populateNginxConfig(fs);
  populatePhpFpmConfig(fs);
  populateSmtpCaptureConfig(fs);

  // Build-time MariaDB bootstrap script + default wp-config. The browser host
  // overwrites wp-config.php with the current page prefix/protocol before dinit starts.
  writeVfsFile(fs, "/etc/mariadb/bootstrap.sh", MARIADB_BOOTSTRAP_SCRIPT);
  writeVfsFile(fs, "/etc/wp-config-template.php", wordpressConfigTemplate("mariadb"));
  writeVfsFile(fs, "/etc/wp-config-init.sh", WORDPRESS_CONFIG_INIT_SCRIPT);
  ensureDirRecursive(fs, "/var/www/html");
  writeVfsFile(fs, "/var/www/html/wp-config.php", renderWordPressConfig("mariadb", "/app", "http"));
  writeVfsFile(fs, "/var/www/html/kandelo-mysql-bench.php", MYSQL_BENCHMARK_PHP);

  // WordPress-specific dirs + mu-plugin
  ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");
  writeVfsFile(
    fs,
    "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php",
    wordpressSmtpCaptureMuPlugin(),
  );

  console.log("Writing WordPress core files...");
  const excludeDb = (rel: string) =>
    rel.endsWith(".db") || rel === "wp-config.php" || rel.includes("wp-content/db.php");
  const wpCount = walkAndWrite(fs, WP_DIR, "/var/www/html", { exclude: excludeDb });
  patchWordPressPersistentMysqli(fs);
  console.log(`  WordPress core: ${wpCount} files`);

  // Service tree
  addDinitInit(fs, buildServices(fs));

  await preinstallWordPressMariaDb(fs);

  // Prewarm opcache: see build-wp-vfs-image.ts for context.
  await prewarmOpcache(fs, {
    sourceRoots: ["/var/www"],
    label: "lamp",
    excludePaths: [
      "/var/www/html/wp-config.php",
      "/var/www/html/wp-includes/SimplePie/autoloader.php",
    ],
  });
  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      "wordpress-mariadb": { presentation: webPresentation() },
      lamp: { presentation: webPresentation() },
    },
  });

  await saveShellDerivedVfsImage(fs, OUT_FILE);
  console.log(`${wpCount} WordPress files total`);
}

main().catch((err) => { console.error(err); process.exit(1); });
