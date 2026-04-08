import{k as W,B as N}from"./browser-kernel-3EHx8tzG.js";/* empty css               */import{n as C,H as F,l as u}from"./nginx-DS843j_U.js";import{l as j}from"./wp-bundle-CEfoOdTg.js";import{p as q}from"./worker-main-N8-Fr_O9.js";import{p as G}from"./php-fpm-twWFbNDX.js";import{m as z,s as K,a as V}from"./mysql_system_tables_data-BEXINe6V.js";const g="/wasm-posix-kernel/app/",h="/wasm-posix-kernel/app",P=window.location.protocol==="https:"?"https":"http",l=document.getElementById("log"),m=document.getElementById("start"),T=document.getElementById("reload"),c=document.getElementById("status");let x=document.getElementById("frame");const E=new TextDecoder;function t(n,i){const s=document.createElement("span");i&&(s.className=i),s.textContent=n,l.appendChild(s),l.scrollTop=l.scrollHeight}function o(n,i){c.style.display="block",c.textContent=n,c.className=`status ${i}`}const Y=`daemon off;
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

    types {
        text/html  html htm;
        text/css   css;
        text/javascript js;
        application/javascript js;
        application/json json;
        image/png png;
        image/jpeg jpg jpeg;
        image/gif gif;
        image/svg+xml svg;
        image/x-icon ico;
        font/woff woff;
        font/woff2 woff2;
        application/x-font-ttf ttf;
    }
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
            fastcgi_param REDIRECT_STATUS 200;
        }
    }
}
`,Q=`[global]
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
request_terminate_timeout = 120
`,X=`<?php
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
`,J=`<?php
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
define('WP_DEBUG_DISPLAY', true);

if (isset($_SERVER['HTTP_HOST'])) {
    define('WP_HOME', '${P}://' . $_SERVER['HTTP_HOST'] . '${h}');
    define('WP_SITEURL', '${P}://' . $_SERVER['HTTP_HOST'] . '${h}');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`,Z=`<?php
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function($pre, $args, $url) {
    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
}, 10, 3);
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;let r=null,f=null;async function ee(){m.disabled=!0,l.textContent="",o("Loading LAMP stack...","loading");try{t(`Fetching wasm binaries + MariaDB bootstrap SQL...
`,"info");const[n,i,s,p,S,y]=await Promise.all([fetch(W).then(e=>e.arrayBuffer()),fetch(z).then(e=>e.arrayBuffer()),fetch(C).then(e=>e.arrayBuffer()),fetch(G).then(e=>e.arrayBuffer()),fetch(K).then(e=>e.text()),fetch(V).then(e=>e.text())]);t(`Kernel: ${(n.byteLength/1024).toFixed(0)}KB, MariaDB: ${(i.byteLength/(1024*1024)).toFixed(1)}MB, nginx: ${(s.byteLength/(1024*1024)).toFixed(1)}MB, PHP-FPM: ${(p.byteLength/(1024*1024)).toFixed(1)}MB
`,"info"),t(`Pre-compiling MariaDB thread module...
`,"info"),o("Pre-compiling MariaDB thread module...","loading");const B=q(i),b=await WebAssembly.compile(B);if(t(`Thread module ready
`,"info"),f=new F,t(`Initializing service worker bridge...
`,"info"),!await te(f)){o("Service worker initialization failed","error");return}t(`Service worker bridge ready
`,"info"),r=new N({maxWorkers:16,fsSize:128*1024*1024,threadModule:b,onStdout:e=>t(E.decode(e)),onStderr:e=>{const a=E.decode(e);t(a,"stderr"),console.log(`[STDERR] ${a.trim()}`)}}),await r.init(n);const d=r.fs;for(const e of["/data","/data/mysql","/data/tmp","/data/test","/etc/nginx","/var/www/html","/var/www/html/wp-content","/var/www/html/wp-content/mu-plugins","/var/log/nginx","/tmp/nginx_client_temp","/tmp/nginx_fastcgi_temp","/tmp/nginx_proxy_temp","/tmp/nginx_uwsgi_temp","/tmp/nginx_scgi_temp","/tmp/nginx-wasm/logs","/etc/php-fpm.d"]){const a=e.split("/").filter(Boolean);let w="";for(const U of a){w+="/"+U;try{d.mkdir(w,493)}catch{}}}await u(d,[{path:"/etc/nginx/nginx.conf",data:Y},{path:"/etc/php-fpm.conf",data:Q},{path:"/var/www/fpm-router.php",data:X}]),o("Loading WordPress files...","loading"),t(`Loading WordPress bundle...
`,"info");const R=await j(d,"/wasm-posix-kernel/wp-bundle.json",(e,a)=>{(e%500===0||e===a)&&t(`  ${e}/${a} files
`,"info")});t(`WordPress loaded: ${R} files
`,"info");try{d.unlink("/var/www/html/wp-content/db.php")}catch{}await u(d,[{path:"/var/www/html/wp-config.php",data:J},{path:"/var/www/html/wp-content/mu-plugins/wasm-optimizations.php",data:Z}]),o("Bootstrapping MariaDB system tables...","loading"),t(`Bootstrapping MariaDB system tables (this may take a few minutes in browser)...
`,"info");const v=`use mysql;
${S}
${y}
CREATE DATABASE IF NOT EXISTS wordpress;
`,k=new TextEncoder().encode(v),_=r.nextPid,D=r.spawn(i,["mariadbd","--no-defaults","--datadir=/data","--tmpdir=/data/tmp","--default-storage-engine=Aria","--skip-grant-tables","--key-buffer-size=1048576","--table-open-cache=10","--sort-buffer-size=262144","--bootstrap","--log-warnings=0"],{stdin:k}),M=new Promise(e=>{const a=async()=>{await r.isStdinConsumed(_)?setTimeout(()=>e(0),2e3):setTimeout(a,500)};setTimeout(a,1e3)}),H=new Promise(e=>setTimeout(()=>e(-1),6e5)),O=setInterval(()=>{t(`  Bootstrap still running...
`,"info")},15e3),A=await Promise.race([D,M,H]);if(clearInterval(O),A===-1)throw new Error("MariaDB bootstrap timed out after 10 minutes. Try reloading the page.");t(`Bootstrap complete
`,"info"),await r.terminateProcess(_),t(`WordPress database ready
`,"info"),o("Starting MariaDB server...","loading"),t(`Starting MariaDB server on 127.0.0.1:3306...
`,"info"),r.spawn(i,["mariadbd","--no-defaults","--datadir=/data","--tmpdir=/data/tmp","--default-storage-engine=Aria","--skip-grant-tables","--key-buffer-size=1048576","--table-open-cache=10","--sort-buffer-size=262144","--skip-networking=0","--port=3306","--bind-address=0.0.0.0","--socket=","--max-connections=10","--thread-handling=no-threads"]),t(`Waiting for MariaDB to accept connections...
`,"info");for(let e=1;e<=30;e++){if(await new Promise(a=>setTimeout(a,1e3)),await r.pickListenerTarget(3306)){t(`MariaDB ready (after ${e}s)
`,"info");break}if(e===30)throw new Error("MariaDB did not start listening within 30s");e%5===0&&t(`Still waiting for MariaDB... (${e}s)
`,"info")}o("Starting PHP-FPM...","loading"),t(`Starting PHP-FPM on 127.0.0.1:9000...
`,"info");const L=r.spawn(p,["php-fpm","-y","/etc/php-fpm.conf","-c","/dev/null","--nodaemonize"],{env:["HOME=/tmp","TMPDIR=/tmp","PATH=/usr/local/bin:/usr/bin:/bin"]});await new Promise(e=>setTimeout(e,3e3)),t(`PHP-FPM ready
`,"info"),o("Starting nginx...","loading"),t(`Starting nginx on 127.0.0.1:8080...
`,"info"),r.sendBridgePort(f.detachHostPort(),8080);const I=r.spawn(s,["nginx","-p","/etc/nginx","-c","nginx.conf"],{env:["HOME=/tmp","TMPDIR=/tmp","PATH=/usr/bin:/bin"]});await new Promise(e=>setTimeout(e,2e3)),o("LAMP stack running! Loading WordPress...","running"),T.disabled=!1,t(`
=== LAMP stack running ===
`,"info"),t(`  MariaDB: 127.0.0.1:3306
`,"info"),t(`  PHP-FPM: 127.0.0.1:9000
`,"info"),t(`  nginx:   127.0.0.1:8080
`,"info"),t(`  WordPress: ${g}

`,"info"),$(),L.then(e=>{t(`
php-fpm exited with code ${e}
`,"info")}),I.then(e=>{t(`
nginx exited with code ${e}
`,"info")})}catch(n){t(`
Error: ${n}
`,"stderr"),o(`Error: ${n}`,"error"),console.error(n),m.disabled=!1}}function $(){const n=document.createElement("iframe");n.id="frame",n.src=g,x.replaceWith(n),x=n}async function te(n){if(!("serviceWorker"in navigator))return t(`Service Workers not supported
`,"stderr"),!1;try{await navigator.serviceWorker.register("/wasm-posix-kernel/service-worker.js");const i=await navigator.serviceWorker.ready;return await new Promise(s=>{const p=new MessageChannel;p.port1.onmessage=()=>s(),i.active.postMessage({type:"init-bridge",appPrefix:g},[n.getSwPort(),p.port2])}),!0}catch(i){return t(`Service worker error: ${i}
`,"stderr"),!1}}m.addEventListener("click",ee);T.addEventListener("click",$);
