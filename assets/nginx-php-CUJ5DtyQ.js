import{k as y,B as v}from"./browser-kernel-3EHx8tzG.js";/* empty css               */import{n as b,H as R,l as T}from"./nginx-DS843j_U.js";import{p as S}from"./php-fpm-twWFbNDX.js";const h="/wasm-posix-kernel/app/",d=document.getElementById("log"),c=document.getElementById("start"),_=document.getElementById("reload"),l=document.getElementById("status");let g=document.getElementById("frame");const f=new TextDecoder;function r(t,n){const o=document.createElement("span");n&&(o.className=n),o.textContent=t,d.appendChild(o),d.scrollTop=d.scrollHeight}function i(t,n){l.style.display="block",l.textContent=t,l.className=`status ${n}`}const k=`daemon off;
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
        index index.php index.html;

        location / {
        }

        # Exact match — no PCRE regex needed
        location = /index.php {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_param SCRIPT_FILENAME $document_root/index.php;
            fastcgi_param QUERY_STRING $query_string;
            fastcgi_param REQUEST_METHOD $request_method;
            fastcgi_param CONTENT_TYPE $content_type;
            fastcgi_param CONTENT_LENGTH $content_length;
            fastcgi_param SERVER_PROTOCOL $server_protocol;
            fastcgi_param SERVER_PORT $server_port;
            fastcgi_param SERVER_NAME $server_name;
            fastcgi_param REQUEST_URI $request_uri;
            fastcgi_param DOCUMENT_URI $document_uri;
            fastcgi_param DOCUMENT_ROOT $document_root;
            fastcgi_param HTTP_X_FORWARDED_PROTO $http_x_forwarded_proto;
            fastcgi_param REDIRECT_STATUS 200;
        }
    }
}
`,$=`[global]
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
`,H=`<?php
$uptime = time();
$mem = memory_get_usage(true);
$extensions = get_loaded_extensions();
sort($extensions);
?>
<!DOCTYPE html>
<html>
<head>
    <title>PHP-FPM on wasm-posix-kernel</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
        h1 { color: #333; }
        .info { background: #f0f0f0; padding: 1rem; border-radius: 4px; margin: 1rem 0; }
        table { border-collapse: collapse; width: 100%; }
        td, th { padding: 0.4rem; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f5f5f5; }
        code { background: #e0e0e0; padding: 0.2rem 0.4rem; border-radius: 2px; }
    </style>
</head>
<body>
    <h1>PHP-FPM on WebAssembly</h1>
    <div class="info">
        <p>This page is served by <strong>nginx</strong> + <strong>PHP-FPM</strong>, both
        running inside a POSIX kernel compiled to WebAssembly.</p>
        <p>FastCGI traffic between nginx and PHP-FPM flows over the kernel's
        internal loopback (127.0.0.1:9000).</p>
    </div>
    <table>
        <tr><th>Property</th><th>Value</th></tr>
        <tr><td>PHP Version</td><td><?= PHP_VERSION ?></td></tr>
        <tr><td>OS</td><td><?= PHP_OS ?></td></tr>
        <tr><td>SAPI</td><td><?= php_sapi_name() ?></td></tr>
        <tr><td>Memory</td><td><?= number_format($mem / 1024) ?> KB</td></tr>
        <tr><td>Server Software</td><td><?= $_SERVER['SERVER_SOFTWARE'] ?? 'N/A' ?></td></tr>
        <tr><td>Server Protocol</td><td><?= $_SERVER['SERVER_PROTOCOL'] ?? 'N/A' ?></td></tr>
    </table>
    <h3 style="margin-top: 1rem">Loaded Extensions (<?= count($extensions) ?>)</h3>
    <p style="font-size: 0.85rem; color: #666">
        <?= implode(', ', $extensions) ?>
    </p>
    <h3 style="margin-top: 1rem">Architecture</h3>
    <ol>
        <li>Browser fetch &rarr; Service Worker intercepts</li>
        <li>Service Worker &rarr; MessageChannel &rarr; Main Thread</li>
        <li>Main Thread injects TCP connection into kernel</li>
        <li>nginx (Wasm) accepts, routes <code>.php</code> to FastCGI</li>
        <li>PHP-FPM (Wasm) processes PHP via kernel loopback</li>
        <li>Response flows back through the same pipe</li>
    </ol>
</body>
</html>
`;let a=null,p=null;async function M(){c.disabled=!0,d.textContent="",i("Loading kernel, nginx, and PHP-FPM...","loading");try{r(`Fetching wasm binaries...
`,"info");const[t,n,o]=await Promise.all([fetch(y).then(e=>e.arrayBuffer()),fetch(b).then(e=>e.arrayBuffer()),fetch(S).then(e=>e.arrayBuffer())]);if(r(`Kernel: ${(t.byteLength/1024).toFixed(0)}KB, nginx: ${(n.byteLength/(1024*1024)).toFixed(1)}MB, PHP-FPM: ${(o.byteLength/(1024*1024)).toFixed(1)}MB
`,"info"),p=new R,r(`Initializing service worker bridge...
`,"info"),!await F(p)){i("Service worker initialization failed","error");return}r(`Service worker bridge ready
`,"info"),a=new v({onStdout:e=>r(f.decode(e)),onStderr:e=>r(f.decode(e),"stderr")}),await a.init(t),r(`Populating filesystem...
`,"info");const s=a.fs;for(const e of["/etc/nginx","/var/www/html","/var/log/nginx","/tmp/nginx_client_temp","/tmp/nginx_fastcgi_temp","/tmp/nginx-wasm/logs","/etc/php-fpm.d"]){const w=e.split("/").filter(Boolean);let m="";for(const E of w){m+="/"+E;try{s.mkdir(m,493)}catch{}}}await T(s,[{path:"/etc/nginx/nginx.conf",data:k},{path:"/etc/php-fpm.conf",data:$},{path:"/var/www/html/index.php",data:H}]),a.sendBridgePort(p.detachHostPort(),8080),i("Starting PHP-FPM...","loading"),r(`Starting PHP-FPM (pid 1)...
`,"info");const u=a.spawn(o,["php-fpm","-y","/etc/php-fpm.conf","-c","/dev/null","--nodaemonize"],{env:["HOME=/tmp","TMPDIR=/tmp","PATH=/usr/local/bin:/usr/bin:/bin"]});await new Promise(e=>setTimeout(e,3e3)),r(`PHP-FPM ready
`,"info"),i("Starting nginx...","loading"),r(`Starting nginx (pid 3)...
`,"info");const x=a.spawn(n,["nginx","-p","/etc/nginx","-c","nginx.conf"],{env:["HOME=/tmp","TMPDIR=/tmp","PATH=/usr/bin:/bin"]});await new Promise(e=>setTimeout(e,2e3)),i("nginx + PHP-FPM running! Loading page...","running"),_.disabled=!1,P(),u.then(e=>{r(`
php-fpm exited with code ${e}
`,"info")}),x.then(e=>{r(`
nginx exited with code ${e}
`,"info")})}catch(t){r(`
Error: ${t}
`,"stderr"),i(`Error: ${t}`,"error"),console.error(t),c.disabled=!1}}function P(){const t=document.createElement("iframe");t.id="frame",t.src=h+"index.php",g.replaceWith(t),g=t}async function F(t){if(!("serviceWorker"in navigator))return r(`Service Workers not supported
`,"stderr"),!1;try{await navigator.serviceWorker.register("/wasm-posix-kernel/service-worker.js");const n=await navigator.serviceWorker.ready;return await new Promise(o=>{const s=new MessageChannel;s.port1.onmessage=()=>o(),n.active.postMessage({type:"init-bridge",appPrefix:h},[t.getSwPort(),s.port2])}),!0}catch(n){return r(`Service worker error: ${n}
`,"stderr"),!1}}c.addEventListener("click",M);_.addEventListener("click",P);
