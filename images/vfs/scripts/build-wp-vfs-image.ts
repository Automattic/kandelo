/**
 * Build a fully-bootable VFS image for the WordPress browser demo. The image
 * starts from shell.vfs.zst, then dinit (PID 1) brings up:
 *
 *   wp-config-init (internal) + smtp-capture (process)
 *       → php-fpm (process) → nginx (process)
 *
 * The browser host overwrites wp-config.php with the page-supplied
 * @@APP_PATH@@ and @@PROTO@@ values before dinit starts. Keeping that
 * substitution host-side avoids a shell fork during service boot.
 *
 * Produces: apps/browser-demos/public/wordpress.vfs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDirRecursive,
} from "./vfs-image-helpers";
import { addDinitInit, type DinitService } from "./dinit-image-helpers";
import { prewarmOpcache } from "./opcache-prewarm";
import {
  webPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";
import {
  populateSmtpCaptureConfig,
  smtpCaptureService,
  wordpressSmtpCaptureMuPlugin,
} from "./smtp-capture-helpers";
import {
  loadShellBaseFileSystem,
  saveShellDerivedVfsImage,
} from "./shell-vfs-build";
import {
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
} from "../../../web-libs/kandelo-session/src/vfs-capacity";
import {
  WORDPRESS_CONFIG_INIT_SCRIPT,
  renderWordPressConfig,
  wordpressConfigTemplate,
} from "../../../apps/browser-demos/lib/init/wordpress-runtime-config";
import { preinstallWordPressSqlite } from "./wordpress-preinstall";
import {
  copyWordPressCoreSource,
  materializeWordPressSqlitePlugin,
  resolveWordPressCoreSource,
  resolveWordPressSqlitePluginSource,
} from "./wordpress-source-layout";

const REPO_ROOT = findRepoRoot();
const BROWSER_DIR = join(REPO_ROOT, "apps", "browser-demos");
const WP_DIR = resolveWordPressCoreSource(REPO_ROOT);
const SQLITE_DIR = resolveWordPressSqlitePluginSource();
const NGINX_PATH = resolveBinary("programs/nginx.wasm");
const PHP_FPM_PATH = resolveBinary("programs/php/php-fpm.wasm");
const OPCACHE_SO_PATH = resolveBinary("programs/php/opcache.so");
const MSMTPD_PATH = resolveBinary("programs/msmtpd.wasm");
const OUT_FILE = join(BROWSER_DIR, "public", "wordpress.vfs.zst");
const PHP_FPM_WORKERS = 1;
const PHP_FPM_UID = 65534;
const PHP_FPM_GID = 65534;
// WordPress layers service binaries and application data on the complete
// canonical shell, so its product profile must admit that 512 MiB base.
const WORDPRESS_IMAGE_MAX_BYTES = SHELL_DERIVED_VFS_PROFILE_MAX_BYTES;

// --- Service configs (reuse logic from init modules) ---

function ensureWritableByPhpFpm(fs: MemoryFileSystem, path: string): void {
  ensureDirRecursive(fs, path);
  fs.chown(path, PHP_FPM_UID, PHP_FPM_GID);
  fs.chmod(path, 0o775);
}

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
pm.max_children = ${PHP_FPM_WORKERS}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;

  writeVfsFile(fs, "/etc/php-fpm.conf", phpFpmConf);

  // opcache: file-cache backend, populated at build time by
  // prewarmOpcache (see end of main()). Anon MAP_SHARED is per-process
  // in our wasm port, so the original SHM backend gave zero cross-
  // worker reuse and *added* MINIT cost per request (issue #493
  // investigation). file_cache_only=1 writes compiled bytecode to
  // /var/cache/opcache, which lives in the rootfs image, so every FPM
  // worker reads the same cache files via the kernel's shared VFS.
  // validate_timestamps=0 is safe because VFS files don't change at
  // runtime.
  ensureDirRecursive(fs, "/usr/lib/php/extensions");
  writeVfsBinary(
    fs,
    "/usr/lib/php/extensions/opcache.so",
    new Uint8Array(readFileSync(OPCACHE_SO_PATH)),
  );
  const phpIni = `zend_extension=/usr/lib/php/extensions/opcache.so

curl.cainfo=/etc/ssl/certs/ca-certificates.crt
openssl.cafile=/etc/ssl/certs/ca-certificates.crt

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
 *   wp-config-init (internal) — dependency marker. The browser host writes
 *                               the runtime wp-config.php before dinit starts.
 *   smtp-capture   (process)  — local SMTP sink storing mail under /var/mail
 *   php-fpm        (process)  — depends-on wp-config-init + smtp-capture
 *   nginx          (process)  — depends-on php-fpm
 */
function buildServices(): DinitService[] {
  return [
    {
      name: "wp-config-init",
      type: "internal",
      restart: false,
    },
    smtpCaptureService(),
    {
      name: "php-fpm",
      type: "process",
      // -c /etc/php.ini points at the VFS-shipped ini that enables the
      // built-in opcache extension. Using an explicit path also avoids
      // the default /usr/local/lib/php/php.ini-development lookup, which
      // trips unsupported-config errors on our wasm port.
      command: "/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /etc/php.ini --nodaemonize",
      dependsOn: ["wp-config-init", "smtp-capture"],
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

// --- Main ---

async function main() {
  console.log("Loading shell base image...");
  const fs = loadShellBaseFileSystem(WORDPRESS_IMAGE_MAX_BYTES);

  console.log("Populating WordPress service configs...");
  populateNginxConfig(fs);
  populatePhpFpmConfig(fs);
  populateSmtpCaptureConfig(fs);

  console.log("Writing nginx + php-fpm + msmtpd binaries...");
  ensureDirRecursive(fs, "/usr/sbin");
  writeVfsBinary(fs, "/usr/sbin/nginx", new Uint8Array(readFileSync(NGINX_PATH)));
  writeVfsBinary(fs, "/usr/sbin/php-fpm", new Uint8Array(readFileSync(PHP_FPM_PATH)));
  writeVfsBinary(fs, "/usr/sbin/msmtpd", new Uint8Array(readFileSync(MSMTPD_PATH)));

  // Template + default wp-config. The browser host overwrites wp-config.php
  // with the current page prefix/protocol before dinit starts.
  ensureDirRecursive(fs, "/var/www/html");
  writeVfsFile(fs, "/etc/wp-config-template.php", wordpressConfigTemplate("sqlite"));
  writeVfsFile(fs, "/etc/wp-config-init.sh", WORDPRESS_CONFIG_INIT_SCRIPT);
  writeVfsFile(fs, "/var/www/html/wp-config.php", renderWordPressConfig("sqlite", "/app", "http"));

  // WordPress-specific directories
  ensureWritableByPhpFpm(fs, "/var/www/html/wp-content/database");
  ensureDirRecursive(fs, "/var/www/html/wp-content/mu-plugins");

  // Keep file-mod operations disabled, but let mail route to the local
  // SMTP capture service and leave outbound HTTP enabled for the bridge.
  writeVfsFile(
    fs,
    "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php",
    wordpressSmtpCaptureMuPlugin(),
  );

  // WordPress core files
  console.log("Writing WordPress core files...");
  let wpCount = copyWordPressCoreSource(fs, WP_DIR);
  console.log(`  WordPress core: ${wpCount} files`);

  // SQLite plugin files
  console.log("Writing SQLite plugin files...");
  const sqliteCount = materializeWordPressSqlitePlugin(fs, SQLITE_DIR);
  console.log(`  SQLite plugin: ${sqliteCount} files`);
  wpCount += sqliteCount;

  // Drop-in db.php → routes WP_DB_HOST to the SQLite plugin instead of
  // MySQL. setup.sh copies sqlite-database-integration/db.copy into
  // wp-content/db.php; do the same here for the source-extracted path.
  const dbCopy = readFileSync(join(SQLITE_DIR, "db.copy"));
  writeVfsBinary(fs, "/var/www/html/wp-content/db.php", new Uint8Array(dbCopy), 0o644);
  wpCount += 1;

  // dinit + service tree. nginx → php-fpm → wp-config-init/smtp-capture
  // dependencies ensure wp-config.php is finalized and SMTP is listening
  // before any FastCGI request.
  addDinitInit(fs, buildServices());

  await preinstallWordPressSqlite(fs);

  // Prewarm opcache: compile the FPM router and every .php under the
  // document root into the file cache at /var/cache/opcache so the first
  // FPM request doesn't pay the parse cost. Issue #493: this collapses
  // the cold-page-render spike from ~900ms to ~450ms in benchmarking.
  await prewarmOpcache(fs, {
    sourceRoots: ["/var/www"],
    label: "wp",
    excludePaths: [
      "/var/www/html/wp-config.php",
      "/var/www/html/wp-includes/SimplePie/autoloader.php",
    ],
  });
  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      "wordpress-sqlite": { presentation: webPresentation() },
      wordpress: { presentation: webPresentation() },
    },
  });

  // Save image
  await saveShellDerivedVfsImage(fs, OUT_FILE);
  console.log(`${wpCount} WordPress files total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
