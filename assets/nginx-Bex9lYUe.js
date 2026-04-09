import{k,B as v}from"./browser-kernel-D6RZ7EaX.js";/* empty css               */import{n as b,H as B,l as P}from"./nginx-_X8VvCpG.js";const h="/wasm-posix-kernel/app/",l=document.getElementById("log"),g=document.getElementById("start"),x=document.getElementById("reload"),d=document.getElementById("status");let p=document.getElementById("frame");const f=new TextDecoder;function n(e,r){const i=document.createElement("span");r&&(i.className=r),i.textContent=e,l.appendChild(i),l.scrollTop=l.scrollHeight}function o(e,r){d.style.display="block",d.textContent=e,d.className=`status ${r}`}const _=`daemon off;
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
        index index.html;

        location / {
        }
    }
}
`,E=`<!DOCTYPE html>
<html>
<head>
    <title>nginx on wasm-posix-kernel</title>
    <style>
        body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
        h1 { color: #333; }
        .info { background: #f0f0f0; padding: 1rem; border-radius: 4px; margin: 1rem 0; }
        code { background: #e0e0e0; padding: 0.2rem 0.4rem; border-radius: 2px; }
    </style>
</head>
<body>
    <h1>Hello from nginx on WebAssembly!</h1>
    <div class="info">
        <p>This page is being served by <strong>nginx</strong> running inside a
        POSIX kernel compiled to WebAssembly.</p>
        <p>The request was intercepted by a Service Worker, routed through
        a MessageChannel bridge to the kernel, where nginx processed it
        and returned this response.</p>
    </div>
    <p>Architecture:</p>
    <ol>
        <li>Browser fetch &rarr; Service Worker intercepts</li>
        <li>Service Worker &rarr; MessageChannel &rarr; Main Thread</li>
        <li>Main Thread injects TCP connection into kernel</li>
        <li>nginx (Wasm) accepts, reads request, serves file</li>
        <li>Response flows back through the same pipe</li>
    </ol>
</body>
</html>
`;let s=null,c=null;async function S(){g.disabled=!0,l.textContent="",o("Loading kernel and nginx...","loading");try{n(`Fetching kernel and nginx wasm...
`,"info");const[e,r]=await Promise.all([fetch(k).then(t=>t.arrayBuffer()),fetch(b).then(t=>t.arrayBuffer())]);if(n(`Kernel: ${(e.byteLength/1024).toFixed(0)}KB, nginx: ${(r.byteLength/1024).toFixed(0)}KB
`,"info"),c=new B,n(`Initializing service worker bridge...
`,"info"),!await W(c)){o("Service worker initialization failed","error");return}n(`Service worker bridge ready
`,"info"),s=new v({onStdout:t=>n(f.decode(t)),onStderr:t=>n(f.decode(t),"stderr")}),await s.init(e),n(`Populating filesystem...
`,"info");const i=s.fs;for(const t of["/etc/nginx","/var/www/html","/var/log/nginx","/tmp/nginx_client_temp","/tmp/nginx-wasm/logs"]){const w=t.split("/").filter(Boolean);let m="";for(const y of w){m+="/"+y;try{i.mkdir(m,493)}catch{}}}await P(i,[{path:"/etc/nginx/nginx.conf",data:_},{path:"/var/www/html/index.html",data:E}]),s.sendBridgePort(c.detachHostPort(),8080),o("Starting nginx (forking workers)...","loading"),n(`Starting nginx...
`,"info");const a=s.spawn(r,["nginx","-p","/etc/nginx","-c","nginx.conf"],{env:["HOME=/root","TMPDIR=/tmp","PATH=/usr/bin:/bin"]});await new Promise(t=>setTimeout(t,2e3)),o("nginx is running! Loading page in iframe...","running"),x.disabled=!1,u(),a.then(t=>{n(`
nginx exited with code ${t}
`,"info"),o(`nginx exited (code ${t})`,"error")})}catch(e){n(`
Error: ${e}
`,"stderr"),o(`Error: ${e}`,"error"),console.error(e),g.disabled=!1}}function u(){const e=document.createElement("iframe");e.id="frame",e.src=h,p.replaceWith(e),p=e}async function W(e){if(!("serviceWorker"in navigator))return n(`Service Workers not supported in this browser
`,"stderr"),!1;try{await navigator.serviceWorker.register("/wasm-posix-kernel/service-worker.js");const r=await navigator.serviceWorker.ready;return await new Promise(i=>{const a=new MessageChannel;a.port1.onmessage=()=>i(),r.active.postMessage({type:"init-bridge",appPrefix:h},[e.getSwPort(),a.port2])}),!0}catch(r){return n(`Service worker error: ${r}
`,"stderr"),!1}}g.addEventListener("click",S);x.addEventListener("click",u);
