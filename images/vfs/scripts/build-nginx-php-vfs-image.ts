/**
 * Build a fully-bootable VFS image for the nginx + PHP-FPM demo. The image
 * starts from shell.vfs.zst, then dinit, the first user process, brings up php-fpm on :9000
 * and nginx on :8080 (depends-on chain ensures php-fpm is up first).
 *
 * Produces: apps/browser-demos/public/nginx-php.vfs
 *
 * Usage: npx tsx images/vfs/scripts/build-nginx-php-vfs-image.ts
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { ensureFile } from "./source-extract-helper";
import {
  addDinitInit,
  type DinitBinaryInputs,
} from "./dinit-image-helpers";
import { prewarmOpcache } from "./opcache-prewarm";
import {
  loadShellBaseFileSystem,
  loadShellBaseFileSystemFromImage,
  saveShellDerivedVfsImage,
} from "./package-shell-vfs-build";
import {
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
} from "../../../web-libs/kandelo-session/src/vfs-capacity";
import { writeTrackedDemoConfig } from "./tracked-demo-config";

const OUT_FILE = join(findRepoRoot(), "apps", "browser-demos", "public", "nginx-php-vfs.vfs.zst");
const PHP_FPM_WORKERS = 6;
const NGINX_PHP_IMAGE_MAX_BYTES = SHELL_DERIVED_VFS_PROFILE_MAX_BYTES;
const DEMO_UID = 1000;
const DEMO_GID = 1000;

const NGINX_CONF = `user root;
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
    types {
        text/html  html;
        text/css   css;
        text/javascript js;
        application/json json;
        image/png  png;
        image/jpeg jpg jpeg;
        image/gif  gif;
        image/svg+xml svg;
    }
    default_type application/octet-stream;

    client_body_temp_path /tmp/nginx_client_temp;
    fastcgi_temp_path     /tmp/nginx_fastcgi_temp;

    server {
        listen 8080;
        server_name localhost;
        root /var/www/html;
        index index.php index.html;

        # Route every request through fpm-router.php so PHP decides static
        # vs dynamic dispatch. Simpler than juggling location ordering for
        # an early-stage demo.
        location / {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_index fpm-router.php;
            include /etc/nginx/fastcgi_params;
            fastcgi_param SCRIPT_FILENAME /var/www/fpm-router.php;
            # Report the requested path (not the router) as SCRIPT_NAME so
            # front controllers like Adminer build self-links against the
            # real URL (/, /info.php) instead of /fpm-router.php.
            fastcgi_param SCRIPT_NAME $document_uri;
        }
    }
}
`;

const FASTCGI_PARAMS = `fastcgi_param  QUERY_STRING       $query_string;
fastcgi_param  REQUEST_METHOD     $request_method;
fastcgi_param  CONTENT_TYPE       $content_type;
fastcgi_param  CONTENT_LENGTH     $content_length;
fastcgi_param  SCRIPT_NAME        $fastcgi_script_name;
fastcgi_param  REQUEST_URI        $request_uri;
fastcgi_param  DOCUMENT_URI       $document_uri;
fastcgi_param  DOCUMENT_ROOT      $document_root;
fastcgi_param  SERVER_PROTOCOL    $server_protocol;
fastcgi_param  REQUEST_SCHEME     $scheme;
fastcgi_param  GATEWAY_INTERFACE  CGI/1.1;
fastcgi_param  SERVER_SOFTWARE    nginx/$nginx_version;
fastcgi_param  REMOTE_ADDR        $remote_addr;
fastcgi_param  REMOTE_PORT        $remote_port;
fastcgi_param  SERVER_ADDR        $server_addr;
fastcgi_param  SERVER_PORT        $server_port;
fastcgi_param  SERVER_NAME        $server_name;
fastcgi_param  REDIRECT_STATUS    200;
`;

const PHP_FPM_CONF = `[global]
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

// opcache: file-cache backend, populated at build time by
// prewarmOpcache (see end of main()). See build-wp-vfs-image.ts for
// the rationale. Timestamp revalidation stays enabled so files edited from
// the demo terminal are reflected after a browser reload.
const PHP_INI = `zend_extension=/usr/lib/php/extensions/opcache.so

[opcache]
opcache.enable=1
opcache.enable_cli=1
opcache.file_cache=/var/cache/opcache
opcache.file_cache_only=1
opcache.validate_timestamps=1
opcache.revalidate_freq=0
`;

const FPM_ROUTER_PHP = `<?php
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

// Runtime location of the demo SQLite database. PHP-FPM (running as `nobody`)
// creates and seeds it on the first request, so /var/www/data must be
// world-writable. The path is shared by the Adminer landing page and any
// terminal/PHP inspection.
const DEMO_DB_PATH = "/var/www/data/demo.db";

// Sample database seeded on first request. A small bookstore schema gives
// Adminer real tables, rows, and a foreign key to browse and edit.
const SEED_SQL = `PRAGMA foreign_keys = ON;

CREATE TABLE authors (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    name    TEXT NOT NULL,
    country TEXT
);

CREATE TABLE books (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    title     TEXT NOT NULL,
    author_id INTEGER REFERENCES authors(id),
    year      INTEGER,
    price     REAL
);

INSERT INTO authors (name, country) VALUES
    ('Ursula K. Le Guin', 'USA'),
    ('Jorge Luis Borges', 'Argentina'),
    ('Italo Calvino', 'Italy'),
    ('Octavia E. Butler', 'USA');

INSERT INTO books (title, author_id, year, price) VALUES
    ('A Wizard of Earthsea', 1, 1968, 12.99),
    ('The Left Hand of Darkness', 1, 1969, 14.50),
    ('Ficciones', 2, 1944, 11.00),
    ('Labyrinths', 2, 1962, 13.25),
    ('Invisible Cities', 3, 1972, 10.75),
    ('If on a winter''s night a traveler', 3, 1979, 15.00),
    ('Kindred', 4, 1979, 13.99),
    ('Parable of the Sower', 4, 1993, 14.99);
`;

// Landing page: Adminer, auto-connected to the pre-seeded SQLite database.
//
// The database is created by PHP-FPM itself on the first request using the
// runtime pdo_sqlite driver (statically linked into php-fpm.wasm) rather than
// baked in from the Node builder, so the demo shows genuine system state. On
// the bare landing request (empty query string) we inject a one-shot SQLite
// login; Adminer then redirects to its normal ?sqlite=... URLs, so the
// injection never re-fires and cannot loop.
const ADMINER_INDEX_PHP = `<?php
$dbPath = '${DEMO_DB_PATH}';
$dataDir = dirname($dbPath);

// Seed the demo database lazily. Workers are race-safe: build into a
// per-process temp file, then atomically rename into place. Every worker
// produces identical content, so last-writer-wins is harmless.
if (!file_exists($dbPath)) {
    if (!is_dir($dataDir)) {
        @mkdir($dataDir, 0777, true);
    }
    $tmp = $dbPath . '.' . getmypid() . '.tmp';
    @unlink($tmp);
    try {
        $pdo = new PDO('sqlite:' . $tmp);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->exec(file_get_contents(__DIR__ . '/seed.sql'));
        $pdo = null;
        @chmod($tmp, 0666);
        if (!file_exists($dbPath)) {
            rename($tmp, $dbPath);
        } else {
            @unlink($tmp);
        }
    } catch (Throwable $e) {
        $pdo = null;
        @unlink($tmp);
    }
}

// One-shot auto-login to the SQLite file on the bare landing request.
if (empty($_GET)) {
    $_POST['auth'] = [
        'driver'   => 'sqlite',
        'server'   => '',
        'username' => '',
        'password' => '',
        'db'       => $dbPath,
    ];
}

function adminer_object() {
    class KandeloAdminer extends Adminer {
        function name() {
            return 'Kandelo SQLite demo';
        }
        function login($login, $password) {
            return true; // single local SQLite file; no credentials needed
        }
        function csp() {
            // Adminer hard-codes 'X-Frame-Options: deny', which blocks the
            // demo from embedding it in the web-preview iframe. Its default
            // CSP has no frame-ancestors directive; adding one makes browsers
            // ignore X-Frame-Options (CSP frame-ancestors takes precedence).
            // The demo shell and the /app iframe are same-origin, so 'self'
            // is sufficient.
            $policies = parent::csp();
            foreach ($policies as $i => $policy) {
                $policies[$i]['frame-ancestors'] = "'self'";
            }
            return $policies;
        }
    }
    return new KandeloAdminer;
}

// Adminer 4.8.1 predates PHP 8 and emits benign warnings (e.g. "array offset
// on null"). Keep them out of the rendered page but still logged to
// php-fpm.log so the compatibility gap stays visible in the real record.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL & ~E_DEPRECATED);
include __DIR__ . '/adminer.php';
`;

// Secondary page kept at /info.php: the original PHP-FPM status view.
const INFO_PHP = `<?php
$mem = memory_get_usage(true);
$extensions = get_loaded_extensions();
sort($extensions);
?>
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>PHP-FPM on kandelo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: #333; }
    .info { background: #f0f0f0; padding: 1rem; border-radius: 4px; margin: 1rem 0; }
    table { border-collapse: collapse; width: 100%; }
    td, th { padding: 0.4rem; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
    a { color: #6b63a6; }
  </style>
</head>
<body>
  <h1>PHP-FPM on WebAssembly</h1>
  <div class="info">
    <p>This page is dynamically rendered by <strong>PHP-FPM</strong>,
    proxied via FastCGI from <strong>nginx</strong>, both running inside
    the same POSIX kernel. dinit, the first user process, brought them up in dependency
    order: php-fpm first, then nginx.</p>
    <p><a href="/">&larr; Back to Adminer</a> &mdash; browse the demo SQLite database.</p>
  </div>
  <table>
    <tr><th>PHP version</th><td><?= PHP_VERSION ?></td></tr>
    <tr><th>OS</th><td><?= PHP_OS ?></td></tr>
    <tr><th>Memory</th><td><?= number_format($mem / 1024) ?> KB</td></tr>
    <tr><th>Extensions</th><td><?= implode(", ", $extensions) ?></td></tr>
  </table>
</body>
</html>
`;

export interface NginxPhpVfsImageBuildInputs {
  shellImage?: Uint8Array;
  nginx: Uint8Array;
  phpFpm: Uint8Array;
  opcache: Uint8Array;
  /** Adminer's single-file PHP release, served as the demo landing page. */
  adminer: Uint8Array;
  dinit?: DinitBinaryInputs;
  buildPrograms?: {
    php: Uint8Array;
    kernel: Uint8Array;
  };
  outputPath: string;
}

export async function buildNginxPhpVfsImage(
  inputs: NginxPhpVfsImageBuildInputs,
): Promise<void> {
  console.log("Loading shell base image...");
  const fs = inputs.shellImage === undefined
    ? await loadShellBaseFileSystem(NGINX_PHP_IMAGE_MAX_BYTES)
    : await loadShellBaseFileSystemFromImage(
        inputs.shellImage,
        NGINX_PHP_IMAGE_MAX_BYTES,
      );
  fs.chmod("/tmp", 0o777);
  ensureDirRecursive(fs, "/usr/sbin");
  ensureDirRecursive(fs, "/run");
  ensureDirRecursive(fs, "/var");
  ensureDirRecursive(fs, "/var/www/html");
  ensureDirRecursive(fs, "/etc/nginx");
  ensureDirRecursive(fs, "/tmp/nginx_client_temp");
  ensureDirRecursive(fs, "/tmp/nginx_fastcgi_temp");

  // Binaries
  writeVfsBinary(fs, "/usr/sbin/nginx", inputs.nginx);
  writeVfsBinary(fs, "/usr/sbin/php-fpm", inputs.phpFpm);
  ensureDirRecursive(fs, "/usr/lib/php/extensions");
  writeVfsBinary(
    fs, "/usr/lib/php/extensions/opcache.so",
    inputs.opcache,
  );

  // Config + content
  writeVfsFile(fs, "/etc/nginx/nginx.conf", NGINX_CONF);
  writeVfsFile(fs, "/etc/nginx/fastcgi_params", FASTCGI_PARAMS);
  writeVfsFile(fs, "/etc/php-fpm.conf", PHP_FPM_CONF);
  writeVfsFile(fs, "/etc/php.ini", PHP_INI);
  writeVfsFile(fs, "/var/www/fpm-router.php", FPM_ROUTER_PHP);
  writeVfsFile(fs, "/var/www/html/index.php", ADMINER_INDEX_PHP);
  writeVfsBinary(fs, "/var/www/html/adminer.php", inputs.adminer, 0o644);
  writeVfsFile(fs, "/var/www/html/seed.sql", SEED_SQL);
  writeVfsFile(fs, "/var/www/html/info.php", INFO_PHP);
  fs.chown("/var/www", DEMO_UID, DEMO_GID);
  fs.chown("/var/www/html", DEMO_UID, DEMO_GID);
  fs.chown("/var/www/fpm-router.php", DEMO_UID, DEMO_GID);
  fs.chown("/var/www/html/index.php", DEMO_UID, DEMO_GID);
  fs.chown("/var/www/html/adminer.php", DEMO_UID, DEMO_GID);
  fs.chown("/var/www/html/seed.sql", DEMO_UID, DEMO_GID);
  fs.chown("/var/www/html/info.php", DEMO_UID, DEMO_GID);
  fs.chmod("/var/www", 0o755);
  fs.chmod("/var/www/html", 0o755);
  fs.chmod("/var/www/fpm-router.php", 0o644);
  fs.chmod("/var/www/html/index.php", 0o644);
  fs.chmod("/var/www/html/adminer.php", 0o644);
  fs.chmod("/var/www/html/seed.sql", 0o644);
  fs.chmod("/var/www/html/info.php", 0o644);

  // Writable data dir for the SQLite database PHP-FPM seeds on first request.
  // php-fpm runs as `nobody`, so this must be world-writable (mirrors the
  // /tmp 1777 precedent above).
  ensureDirRecursive(fs, "/var/www/data");
  fs.chown("/var/www/data", DEMO_UID, DEMO_GID);
  fs.chmod("/var/www/data", 0o777);

  // Prewarm opcache: compile the demo's router and document-root PHP
  // files into the file cache so the first request doesn't pay the parse
  // cost. See build-wp-vfs-image.ts for the full rationale.
  await prewarmOpcache(fs, {
    sourceRoots: ["/var/www"],
    label: "nginx-php",
    programs: inputs.buildPrograms,
  });

  // dinit + service tree. nginx depends on php-fpm so the FastCGI port
  // is up by the time nginx accepts its first request.
  addDinitInit(fs, [
    {
      name: "php-fpm",
      type: "process",
      command: "/usr/sbin/php-fpm --nodaemonize --fpm-config /etc/php-fpm.conf -c /etc/php.ini",
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
  ], { binaries: inputs.dinit });
  writeTrackedDemoConfig(fs, "packages/registry/nginx/nginx-php-demo.json");

  await saveShellDerivedVfsImage(fs, inputs.outputPath);
}

// Adminer ships as one self-contained PHP file with no archive, so it does not
// fit the package resolver's archive/repository source schema. It is fetched
// and sha256-verified directly here instead. These constants also appear as
// provenance in images/vfs/products/browser-nginx-php.toml; bumping them
// invalidates the image cache because this file is a declared build input.
const ADMINER_URL =
  "https://github.com/vrana/adminer/releases/download/v4.8.1/adminer-4.8.1-en.php";
const ADMINER_SHA256 =
  "4ec36be619bb571e2b5a5d4051bfe06f3fcadb3004969b993f2535f6ce28116b";

/**
 * Resolve Adminer's single-file PHP release. A hermetic build can pre-stage
 * the directory containing it via WASM_POSIX_DEP_ADMINER_DIR; otherwise the
 * pinned file is fetched and sha256-verified from its upstream release.
 */
function resolveAdminerSource(): string {
  const alias = process.env.WASM_POSIX_DEP_ADMINER_DIR;
  if (alias !== undefined) {
    return join(alias, "adminer.php");
  }
  return ensureFile({
    url: ADMINER_URL,
    sha256: ADMINER_SHA256,
    cacheKey: "adminer",
  });
}

async function main(): Promise<void> {
  const shellRoot = process.env.WASM_POSIX_DEP_SHELL_DIR;
  const nginxRoot = process.env.WASM_POSIX_DEP_NGINX_DIR;
  const phpRoot = process.env.WASM_POSIX_DEP_PHP_DIR;
  const dinitRoot = process.env.WASM_POSIX_DEP_DINIT_DIR;
  const kernelRoot = process.env.WASM_POSIX_DEP_KERNEL_DIR;
  await buildNginxPhpVfsImage({
    shellImage: shellRoot === undefined
      ? undefined
      : new Uint8Array(readFileSync(join(shellRoot, "shell.vfs.zst"))),
    adminer: new Uint8Array(readFileSync(resolveAdminerSource())),
    nginx: new Uint8Array(readFileSync(nginxRoot === undefined
      ? resolveBinary("programs/nginx.wasm")
      : join(nginxRoot, "nginx.wasm"))),
    phpFpm: new Uint8Array(readFileSync(phpRoot === undefined
      ? resolveBinary("programs/php/php-fpm.wasm")
      : join(phpRoot, "php-fpm.wasm"))),
    opcache: new Uint8Array(readFileSync(phpRoot === undefined
      ? resolveBinary("programs/php/opcache.so")
      : join(phpRoot, "opcache.so"))),
    dinit: dinitRoot === undefined
      ? undefined
      : {
          dinit: new Uint8Array(readFileSync(join(dinitRoot, "dinit.wasm"))),
          dinitctl: new Uint8Array(
            readFileSync(join(dinitRoot, "dinitctl.wasm")),
          ),
        },
    buildPrograms: phpRoot === undefined || kernelRoot === undefined
      ? undefined
      : {
          php: new Uint8Array(readFileSync(join(phpRoot, "php.wasm"))),
          kernel: new Uint8Array(
            readFileSync(join(kernelRoot, "kandelo-kernel.wasm")),
          ),
        },
    outputPath: process.argv[2] ?? OUT_FILE,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
