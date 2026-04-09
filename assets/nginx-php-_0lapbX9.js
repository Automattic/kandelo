import{k as $,B as w}from"./browser-kernel-CeVfDkIW.js";/* empty css               */import{S as F}from"./terminal-panel-sc5ZsZwc.js";import{n as P,p as C}from"./nginx-B-LiObMC.js";import{p as E,a as I}from"./php-fpm-SjRjAukT.js";import{C as O,p as B,w as M,a as c}from"./shell-binaries-DvtU7PcP.js";import{d as v,c as H,g as N,s as L}from"./sed-C3GaF0T-.js";import"./xterm-CyPUMFhC.js";const S="/wasm-posix-kernel/app/",U="/wasm-posix-kernel/service-worker.js",d=document.getElementById("log"),h=document.getElementById("start"),R=document.getElementById("reload"),g=document.getElementById("status"),W=document.getElementById("terminal-panel");let _=document.getElementById("frame");const b=new TextDecoder;function s(t,r){const n=document.createElement("span");r&&(n.className=r),n.textContent=t,d.appendChild(n),d.scrollTop=d.scrollHeight}function l(t,r){g.style.display="block",g.textContent=t,g.className=`status ${r}`}const A=`<?php
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
`,z=`        # Exact match — no PCRE regex needed
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
            fastcgi_param REDIRECT_STATUS 200;
        }`;async function f(t){try{const r=await fetch(t,{method:"HEAD"});return r.ok&&parseInt(r.headers.get("content-length")||"0",10)||0}catch{return 0}}let i=null,x=null;async function D(){h.disabled=!0,d.textContent="",l("Loading kernel, nginx, PHP-FPM, and dash...","loading");try{s(`Fetching kernel and dash wasm...
`,"info");const[t,r,n,p]=await Promise.all([fetch($).then(e=>e.arrayBuffer()),fetch(v).then(e=>e.arrayBuffer()),f(P),f(E)]);s(`Kernel: ${(t.byteLength/1024).toFixed(0)}KB, dash: ${(r.byteLength/1024).toFixed(0)}KB, nginx: ${(n/(1024*1024)).toFixed(1)}MB (lazy), PHP-FPM: ${(p/(1024*1024)).toFixed(1)}MB (lazy)
`,"info");const m=[{url:H,path:"/bin/coreutils",symlinks:[...O,"["].flatMap(e=>[`/bin/${e}`,`/usr/bin/${e}`])},{url:N,path:"/usr/bin/grep",symlinks:["/bin/grep","/usr/bin/egrep","/bin/egrep","/usr/bin/fgrep","/bin/fgrep"]},{url:L,path:"/usr/bin/sed",symlinks:["/bin/sed"]}],u=await Promise.all(m.map(e=>f(e.url))),y=[];for(let e=0;e<m.length;e++)u[e]>0&&y.push({...m[e],size:u[e]});i=new w({onStdout:e=>s(b.decode(e)),onStderr:e=>s(b.decode(e),"stderr")}),await i.init(t),s(`Populating filesystem...
`,"info");const a=i.fs;B(i,r,y);const o=[];n>0&&o.push({path:"/usr/sbin/nginx",url:P,size:n,mode:493}),p>0&&o.push({path:"/usr/sbin/php-fpm",url:E,size:p,mode:493}),o.length>0&&i.registerLazyFiles(o);try{a.mkdir("/usr/sbin",493)}catch{}C(a,{extraLocations:z}),I(a),M(a,"/var/www/html/index.php",A),c(a,"10-php-fpm",{type:"daemon",command:"/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize",ready:"delay:3000"}),c(a,"20-nginx",{type:"daemon",command:"/usr/sbin/nginx -p /etc/nginx -c nginx.conf",depends:"php-fpm",ready:"delay:2000",bridge:"8080"}),c(a,"99-shell",{type:"interactive",command:"/bin/dash -i",env:"TERM=xterm-256color PS1=\\w\\$\\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin",pty:"true",cwd:"/root"}),l("Booting system...","loading"),x=new F(i,{onLog:(e,k)=>s(e+`
`,k==="info"?"info":"stderr"),terminalContainer:W,serviceWorkerUrl:U,appPrefix:S,onServiceReady:e=>{e==="nginx"&&(l("nginx + PHP-FPM running! Loading page...","running"),R.disabled=!1,T())}}),await x.boot()}catch(t){s(`
Error: ${t}
`,"stderr"),l(`Error: ${t}`,"error"),console.error(t),h.disabled=!1}}function T(){const t=document.createElement("iframe");t.id="frame",t.src=S+"index.php",_.replaceWith(t),_=t}h.addEventListener("click",D);R.addEventListener("click",T);
