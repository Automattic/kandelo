import{k as N,B as U}from"./browser-kernel-BPDGIj33.js";import{n as W,H as F,l as j}from"./nginx-DS843j_U.js";import{l as G}from"./wp-bundle-CEfoOdTg.js";import{p as q}from"./worker-main-N8-Fr_O9.js";import{p as z}from"./php-fpm-CRSWaTXS.js";import{m as K,s as V,a as Y}from"./mysql_system_tables_data-BEXINe6V.js";const g="/wasm-posix-kernel/app/",P="/wasm-posix-kernel/app",l=document.getElementById("log"),m=document.getElementById("start"),x=document.getElementById("reload"),c=document.getElementById("status");let E=document.getElementById("frame");const T=new TextDecoder;function t(n,a){const s=document.createElement("span");a&&(s.className=a),s.textContent=n,l.appendChild(s),l.scrollTop=l.scrollHeight}function r(n,a){c.style.display="block",c.textContent=n,c.className=`status ${a}`}const Q=`daemon off;
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
`,X=`[global]
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
`,J=`<?php
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
`,Z=`<?php
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
    define('WP_HOME', '//' . $_SERVER['HTTP_HOST'] . '${P}');
    define('WP_SITEURL', '//' . $_SERVER['HTTP_HOST'] . '${P}');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`;let i=null,f=null;async function ee(){m.disabled=!0,l.textContent="",r("Loading LAMP stack...","loading");try{t(`Fetching wasm binaries + MariaDB bootstrap SQL...
`,"info");const[n,a,s,d,y,B]=await Promise.all([fetch(N).then(e=>e.arrayBuffer()),fetch(K).then(e=>e.arrayBuffer()),fetch(W).then(e=>e.arrayBuffer()),fetch(z).then(e=>e.arrayBuffer()),fetch(V).then(e=>e.text()),fetch(Y).then(e=>e.text())]);t(`Kernel: ${(n.byteLength/1024).toFixed(0)}KB, MariaDB: ${(a.byteLength/(1024*1024)).toFixed(1)}MB, nginx: ${(s.byteLength/(1024*1024)).toFixed(1)}MB, PHP-FPM: ${(d.byteLength/(1024*1024)).toFixed(1)}MB
`,"info"),t(`Pre-compiling MariaDB thread module...
`,"info"),r("Pre-compiling MariaDB thread module...","loading");const $=q(a),b=await WebAssembly.compile($);if(t(`Thread module ready
`,"info"),f=new F,t(`Initializing service worker bridge...
`,"info"),!await te(f)){r("Service worker initialization failed","error");return}t(`Service worker bridge ready
`,"info"),i=new U({maxWorkers:16,fsSize:128*1024*1024,threadModule:b,onStdout:e=>t(T.decode(e)),onStderr:e=>t(T.decode(e),"stderr")}),await i.init(n);const p=i.fs;for(const e of["/data","/data/mysql","/data/tmp","/data/test","/etc/nginx","/var/www/html","/var/www/html/wp-content","/var/log/nginx","/tmp/nginx_client_temp","/tmp/nginx_fastcgi_temp","/tmp/nginx_proxy_temp","/tmp/nginx_uwsgi_temp","/tmp/nginx_scgi_temp","/tmp/nginx-wasm/logs","/etc/php-fpm.d"]){const o=e.split("/").filter(Boolean);let h="";for(const I of o){h+="/"+I;try{p.mkdir(h,493)}catch{}}}await j(p,[{path:"/etc/nginx/nginx.conf",data:Q},{path:"/etc/php-fpm.conf",data:X},{path:"/var/www/fpm-router.php",data:J}]),r("Loading WordPress files...","loading"),t(`Loading WordPress bundle...
`,"info");const R=await G(p,"/wasm-posix-kernel/wp-bundle.json",(e,o)=>{(e%500===0||e===o)&&t(`  ${e}/${o} files
`,"info")});t(`WordPress loaded: ${R} files
`,"info");const _=new TextEncoder().encode(Z),w=p.open("/var/www/html/wp-config.php",578,420);p.write(w,_,0,_.length),p.close(w),r("Bootstrapping MariaDB system tables...","loading"),t(`Bootstrapping MariaDB system tables (this may take a few minutes in browser)...
`,"info");const v=`use mysql;
${y}
${B}
CREATE DATABASE IF NOT EXISTS wordpress;
`,k=new TextEncoder().encode(v),u=i.nextPid,D=i.spawn(a,["mariadbd","--no-defaults","--datadir=/data","--tmpdir=/data/tmp","--default-storage-engine=Aria","--skip-grant-tables","--key-buffer-size=1048576","--table-open-cache=10","--sort-buffer-size=262144","--bootstrap","--log-warnings=0"],{stdin:k}),H=new Promise(e=>{const o=async()=>{await i.isStdinConsumed(u)?setTimeout(()=>e(0),2e3):setTimeout(o,500)};setTimeout(o,1e3)}),M=new Promise(e=>setTimeout(()=>e(-1),6e5)),A=setInterval(()=>{t(`  Bootstrap still running...
`,"info")},15e3),O=await Promise.race([D,H,M]);if(clearInterval(A),O===-1)throw new Error("MariaDB bootstrap timed out after 10 minutes. Try reloading the page.");t(`Bootstrap complete
`,"info"),await i.terminateProcess(u),t(`WordPress database ready
`,"info"),r("Starting MariaDB server...","loading"),t(`Starting MariaDB server on 127.0.0.1:3306...
`,"info"),i.spawn(a,["mariadbd","--no-defaults","--datadir=/data","--tmpdir=/data/tmp","--default-storage-engine=Aria","--skip-grant-tables","--key-buffer-size=1048576","--table-open-cache=10","--sort-buffer-size=262144","--thread-handling=no-threads","--skip-networking=0","--port=3306","--bind-address=0.0.0.0","--socket=","--max-connections=10"]),t(`Waiting for MariaDB to accept connections...
`,"info");for(let e=1;e<=30;e++){if(await new Promise(o=>setTimeout(o,1e3)),await i.pickListenerTarget(3306)){t(`MariaDB ready (after ${e}s)
`,"info");break}if(e===30)throw new Error("MariaDB did not start listening within 30s");e%5===0&&t(`Still waiting for MariaDB... (${e}s)
`,"info")}r("Starting PHP-FPM...","loading"),t(`Starting PHP-FPM on 127.0.0.1:9000...
`,"info");const L=i.spawn(d,["php-fpm","-y","/etc/php-fpm.conf","-c","/dev/null","--nodaemonize"],{env:["HOME=/tmp","TMPDIR=/tmp","PATH=/usr/local/bin:/usr/bin:/bin"]});await new Promise(e=>setTimeout(e,3e3)),t(`PHP-FPM ready
`,"info"),r("Starting nginx...","loading"),t(`Starting nginx on 127.0.0.1:8080...
`,"info"),i.sendBridgePort(f.detachHostPort(),8080);const C=i.spawn(s,["nginx","-p","/etc/nginx","-c","nginx.conf"],{env:["HOME=/tmp","TMPDIR=/tmp","PATH=/usr/bin:/bin"]});await new Promise(e=>setTimeout(e,2e3)),r("LAMP stack running! Loading WordPress...","running"),x.disabled=!1,t(`
=== LAMP stack running ===
`,"info"),t(`  MariaDB: 127.0.0.1:3306
`,"info"),t(`  PHP-FPM: 127.0.0.1:9000
`,"info"),t(`  nginx:   127.0.0.1:8080
`,"info"),t(`  WordPress: ${g}

`,"info"),S(),L.then(e=>{t(`
php-fpm exited with code ${e}
`,"info")}),C.then(e=>{t(`
nginx exited with code ${e}
`,"info")})}catch(n){t(`
Error: ${n}
`,"stderr"),r(`Error: ${n}`,"error"),console.error(n),m.disabled=!1}}function S(){const n=document.createElement("iframe");n.id="frame",n.src=g,E.replaceWith(n),E=n}async function te(n){if(!("serviceWorker"in navigator))return t(`Service Workers not supported
`,"stderr"),!1;try{await navigator.serviceWorker.register("/wasm-posix-kernel/service-worker.js");const a=await navigator.serviceWorker.ready;return await new Promise(s=>{const d=new MessageChannel;d.port1.onmessage=()=>s(),a.active.postMessage({type:"init-bridge",appPrefix:g},[n.getSwPort(),d.port2])}),!0}catch(a){return t(`Service worker error: ${a}
`,"stderr"),!1}}m.addEventListener("click",ee);x.addEventListener("click",S);
