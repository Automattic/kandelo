import{d as i,w as n}from"./shell-binaries-DvtU7PcP.js";function r(e={}){const t=e.listen??"127.0.0.1:9000",o=e.maxChildren??1;return`[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
listen = ${t}
pm = static
pm.max_children = ${o}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`}const l=`<?php
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
`;function s(e,t){const o="/var/www/html";i(e,"/etc/php-fpm.d"),i(e,"/var/log"),i(e,"/tmp/nginx_fastcgi_temp"),n(e,"/etc/php-fpm.conf",r(t));const p=o.replace(/\/[^/]*$/,"");i(e,p),n(e,p+"/fpm-router.php",l)}const f="/wasm-posix-kernel/assets/php-fpm-nmN7kYDT.wasm";export{s as a,f as p};
