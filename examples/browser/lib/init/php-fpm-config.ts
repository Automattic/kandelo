/**
 * PHP-FPM configuration generation and directory setup.
 *
 * Generates php-fpm.conf and fpm-router.php for the wasm-posix-kernel
 * browser environment.
 */
import type { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { writeVfsFile, ensureDirRecursive } from "./vfs-utils";

export interface PhpFpmConfigOptions {
  /** FastCGI listen address (default: "127.0.0.1:9000") */
  listen?: string;
  /** Document root path (default: "/var/www/html") */
  root?: string;
  /** Maximum number of child processes (default: 1) */
  maxChildren?: number;
}

/**
 * Generate a php-fpm.conf string.
 */
function generatePhpFpmConf(options: PhpFpmConfigOptions = {}): string {
  const listen = options.listen ?? "127.0.0.1:9000";
  const maxChildren = options.maxChildren ?? 1;

  return `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
listen = ${listen}
pm = static
pm.max_children = ${maxChildren}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;
}

/**
 * The FPM router PHP script. This handles:
 * - Directory index resolution (path/ -> path/index.php)
 * - Direct .php file execution
 * - PATH_INFO parsing for WordPress-style URLs
 * - Front controller fallback to index.php
 *
 * Used when nginx routes all requests through FastCGI (no PCRE regex
 * locations available in the wasm nginx build).
 */
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

/**
 * Write php-fpm.conf and fpm-router.php, and create required directories.
 */
export function populatePhpFpmConfig(
  fs: MemoryFileSystem,
  options?: PhpFpmConfigOptions,
): void {
  const root = options?.root ?? "/var/www/html";

  ensureDirRecursive(fs, "/etc/php-fpm.d");
  ensureDirRecursive(fs, "/var/log");
  ensureDirRecursive(fs, "/tmp/nginx_fastcgi_temp");

  writeVfsFile(fs, "/etc/php-fpm.conf", generatePhpFpmConf(options));

  // Write the FPM router to /var/www/ (outside the docroot so it's not
  // directly accessible, but referenced by nginx SCRIPT_FILENAME)
  const routerDir = root.replace(/\/[^/]*$/, ""); // parent of root
  ensureDirRecursive(fs, routerDir);
  writeVfsFile(fs, routerDir + "/fpm-router.php", FPM_ROUTER_PHP);
}
