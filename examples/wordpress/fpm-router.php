<?php
/**
 * FPM router script for WordPress behind nginx.
 *
 * Handles three cases:
 *   1. Static files (CSS, JS, images, fonts) — served with correct MIME type
 *   2. PHP files that exist on disk — included directly
 *   3. Everything else — routed through WordPress's index.php
 *
 * This avoids needing PCRE regex locations in the nginx config.
 */

$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$docRoot = $_SERVER['DOCUMENT_ROOT'];
$file = $docRoot . $uri;

// Static file extensions and their MIME types
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

// 1. Serve static files directly
if ($uri !== '/' && is_file($file)) {
    $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
    if (isset($staticTypes[$ext])) {
        header('Content-Type: ' . $staticTypes[$ext]);
        header('Content-Length: ' . filesize($file));
        readfile($file);
        exit;
    }

    // 2. PHP files — include directly
    if ($ext === 'php') {
        chdir(dirname($file));
        include $file;
        exit;
    }
}

// 3. WordPress routing — pretty permalinks and everything else
chdir($docRoot);
include $docRoot . '/index.php';
