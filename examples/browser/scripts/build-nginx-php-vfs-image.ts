/**
 * Build a fully-bootable VFS image for the nginx + PHP-FPM demo.
 * dinit (PID 1) brings up php-fpm on :9000 then nginx on :8080
 * (depends-on chain ensures php-fpm is up first).
 *
 * Produces: examples/browser/public/nginx-php.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-nginx-php-vfs-image.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { saveImage } from "./vfs-image-helpers";
import { addDinitInit } from "./dinit-image-helpers";

const OUT_FILE = join(findRepoRoot(), "examples", "browser", "public", "nginx-php.vfs");

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
            fastcgi_param SCRIPT_NAME /fpm-router.php;
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
pm.max_children = 2
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
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

const INDEX_PHP = `<?php
$mem = memory_get_usage(true);
$extensions = get_loaded_extensions();
sort($extensions);
?>
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>PHP-FPM on wasm-posix-kernel</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: #333; }
    .info { background: #f0f0f0; padding: 1rem; border-radius: 4px; margin: 1rem 0; }
    table { border-collapse: collapse; width: 100%; }
    td, th { padding: 0.4rem; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>PHP-FPM on WebAssembly</h1>
  <div class="info">
    <p>This page is dynamically rendered by <strong>PHP-FPM</strong>,
    proxied via FastCGI from <strong>nginx</strong>, both running inside
    the same POSIX kernel. dinit (PID 1) brought them up in dependency
    order: php-fpm first, then nginx.</p>
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

async function main() {
  const NGINX_WASM = resolveBinary("programs/nginx.wasm");
  const PHP_FPM_WASM = resolveBinary("programs/php/php-fpm.wasm");

  const sab = new SharedArrayBuffer(64 * 1024 * 1024, { maxByteLength: 256 * 1024 * 1024 });
  const fs = MemoryFileSystem.create(sab, 256 * 1024 * 1024);

  for (const dir of ["/tmp", "/home", "/dev", "/etc", "/run", "/var"]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);
  ensureDirRecursive(fs, "/usr/sbin");
  ensureDirRecursive(fs, "/var/www/html");
  ensureDirRecursive(fs, "/etc/nginx");
  ensureDirRecursive(fs, "/tmp/nginx_client_temp");
  ensureDirRecursive(fs, "/tmp/nginx_fastcgi_temp");

  // Binaries
  writeVfsBinary(fs, "/usr/sbin/nginx", new Uint8Array(readFileSync(NGINX_WASM)));
  writeVfsBinary(fs, "/usr/sbin/php-fpm", new Uint8Array(readFileSync(PHP_FPM_WASM)));

  // Config + content
  writeVfsFile(fs, "/etc/nginx/nginx.conf", NGINX_CONF);
  writeVfsFile(fs, "/etc/nginx/fastcgi_params", FASTCGI_PARAMS);
  writeVfsFile(fs, "/etc/php-fpm.conf", PHP_FPM_CONF);
  writeVfsFile(fs, "/var/www/fpm-router.php", FPM_ROUTER_PHP);
  writeVfsFile(fs, "/var/www/html/index.php", INDEX_PHP);

  // dinit + service tree. nginx depends on php-fpm so the FastCGI port
  // is up by the time nginx accepts its first request.
  addDinitInit(fs, [
    {
      name: "php-fpm",
      type: "process",
      command: "/usr/sbin/php-fpm --nodaemonize --fpm-config /etc/php-fpm.conf",
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
  ]);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
