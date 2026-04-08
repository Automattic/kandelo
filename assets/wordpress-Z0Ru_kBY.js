import{k as S,B as v}from"./browser-kernel-3EHx8tzG.js";/* empty css               */import{n as O,H,l as m}from"./nginx-DS843j_U.js";import{l as y}from"./wp-bundle-CEfoOdTg.js";import{p as B}from"./php-fpm-twWFbNDX.js";const T="/wasm-posix-kernel/app/",g="/wasm-posix-kernel/app",d=document.getElementById("log"),c=document.getElementById("start"),P=document.getElementById("reload"),_=document.getElementById("status");let w=document.getElementById("frame");const E=new TextDecoder;function n(t,i){const r=document.createElement("span");i&&(r.className=i),r.textContent=t,d.appendChild(r),d.scrollTop=d.scrollHeight}function o(t,i){_.style.display="block",_.textContent=t,_.className=`status ${i}`}const D=`daemon off;
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
    fastcgi_temp_path /tmp/nginx_fastcgi_temp;
    proxy_temp_path /tmp/nginx_proxy_temp;

    default_type application/octet-stream;

    server {
        listen 8080;
        server_name localhost;
        root /var/www/html;

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
            fastcgi_param HTTP_X_FORWARDED_PROTO $http_x_forwarded_proto;
            fastcgi_param REDIRECT_STATUS 200;
        }
    }
}
`,L=`<?php
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

// Resolve directory URLs to index.php (e.g. /wp-admin/ → /wp-admin/index.php)
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
`,A=`[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
listen = 127.0.0.1:9000
pm = static
pm.max_children = 1
clear_env = no
`,k=`<?php
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
// and strips it before sending to nginx
if (isset($_SERVER['HTTP_HOST'])) {
    $proto = 'http';
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') $proto = 'https';
    elseif (!empty($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') $proto = 'https';
    define('WP_HOME', $proto . '://' . $_SERVER['HTTP_HOST'] . '${g}');
    define('WP_SITEURL', $proto . '://' . $_SERVER['HTTP_HOST'] . '${g}');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`,I=`<?php
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function($pre, $args, $url) {
    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
}, 10, 3);
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;let s=null,f=null;async function b(){c.disabled=!0,d.textContent="",o("Loading WordPress...","loading");try{n(`Fetching wasm binaries + WordPress bundle...
`,"info");const[t,i,r]=await Promise.all([fetch(S).then(e=>e.arrayBuffer()),fetch(O).then(e=>e.arrayBuffer()),fetch(B).then(e=>e.arrayBuffer())]);if(n(`Kernel: ${(t.byteLength/1024).toFixed(0)}KB, nginx: ${(i.byteLength/(1024*1024)).toFixed(1)}MB, PHP-FPM: ${(r.byteLength/(1024*1024)).toFixed(1)}MB
`,"info"),f=new H,n(`Initializing service worker bridge...
`,"info"),!await N(f)){o("Service worker initialization failed","error");return}n(`Service worker bridge ready
`,"info"),s=new v({maxWorkers:8,fsSize:256*1024*1024,maxMemoryPages:4096,onStdout:e=>n(E.decode(e)),onStderr:e=>n(E.decode(e),"stderr")}),await s.init(t);const a=s.fs;for(const e of["/etc/nginx","/var/www/html","/var/www/html/wp-content","/var/www/html/wp-content/database","/var/www/html/wp-content/mu-plugins","/var/log/nginx","/tmp/nginx_client_temp","/tmp/nginx_fastcgi_temp","/tmp/nginx_proxy_temp","/tmp/nginx-wasm/logs","/etc/php-fpm.d"]){const p=e.split("/").filter(Boolean);let l="";for(const R of p){l+="/"+R;try{a.mkdir(l,493)}catch{}}}await m(a,[{path:"/etc/nginx/nginx.conf",data:D},{path:"/etc/php-fpm.conf",data:A},{path:"/var/www/fpm-router.php",data:L}]),o("Starting PHP-FPM...","loading"),n(`Starting PHP-FPM...
`,"info");const x=s.spawn(r,["php-fpm","-y","/etc/php-fpm.conf","-c","/dev/null","--nodaemonize"],{env:["HOME=/tmp","TMPDIR=/tmp","PATH=/usr/local/bin:/usr/bin:/bin"]});await new Promise(e=>setTimeout(e,5e3)),o("Starting nginx...","loading"),n(`Starting nginx...
`,"info");const u=s.spawn(i,["nginx","-p","/etc/nginx","-c","nginx.conf"],{env:["HOME=/tmp","TMPDIR=/tmp","PATH=/usr/bin:/bin"]});await new Promise(e=>setTimeout(e,3e3)),o("Loading WordPress files...","loading");const $=await y(a,"/wasm-posix-kernel/wp-bundle.json",(e,p)=>{(e%500===0||e===p)&&n(`  ${e}/${p} files
`,"info")});n(`WordPress loaded: ${$} files
`,"info");try{a.unlink("/var/www/html/wp-content/database/wordpress.db")}catch{}await m(a,[{path:"/var/www/html/wp-config.php",data:k},{path:"/var/www/html/wp-content/mu-plugins/wasm-optimizations.php",data:I}]),s.sendBridgePort(f.detachHostPort(),8080),o("WordPress running! Loading page...","running"),P.disabled=!1,h(),x.then(e=>{n(`
php-fpm exited with code ${e}
`,"info")}),u.then(e=>{n(`
nginx exited with code ${e}
`,"info")})}catch(t){n(`
Error: ${t}
`,"stderr"),o(`Error: ${t}`,"error"),console.error(t),c.disabled=!1}}function h(){const t=document.createElement("iframe");t.id="frame",t.src=T,w.replaceWith(t),w=t}async function N(t){if(!("serviceWorker"in navigator))return n(`Service Workers not supported
`,"stderr"),!1;try{await navigator.serviceWorker.register("/wasm-posix-kernel/service-worker.js");const i=await navigator.serviceWorker.ready;return await new Promise(r=>{const a=new MessageChannel;a.port1.onmessage=()=>r(),i.active.postMessage({type:"init-bridge",appPrefix:T},[t.getSwPort(),a.port2])}),!0}catch(i){return n(`Service worker error: ${i}
`,"stderr"),!1}}c.addEventListener("click",b);P.addEventListener("click",h);
