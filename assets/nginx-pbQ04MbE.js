import{k as S,B as v}from"./browser-kernel-DeZfH_RD.js";/* empty css               */import{S as W}from"./terminal-panel-sc5ZsZwc.js";import{n as u,p as I}from"./nginx-Cq4QJjHN.js";import{C as P,p as C,w as L,a as f}from"./shell-binaries-DvtU7PcP.js";import{d as T,c as M,g as z,s as U}from"./sed-CaEQBVG8.js";import"./xterm-CyPUMFhC.js";const k="/wasm-posix-kernel/app/",$="/wasm-posix-kernel/service-worker.js",l=document.getElementById("log"),m=document.getElementById("start"),w=document.getElementById("reload"),c=document.getElementById("status"),F=document.getElementById("terminal-panel");let h=document.getElementById("frame");const y=new TextDecoder;function i(n,t){const r=document.createElement("span");t&&(r.className=t),r.textContent=n,l.appendChild(r),l.scrollTop=l.scrollHeight}function o(n,t){c.style.display="block",c.textContent=n,c.className=`status ${t}`}const A=`<!DOCTYPE html>
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
`;async function b(n){try{const t=await fetch(n,{method:"HEAD"});return t.ok&&parseInt(t.headers.get("content-length")||"0",10)||0}catch{return 0}}let s=null,x=null;async function D(){m.disabled=!0,l.textContent="",o("Loading kernel, nginx, and dash...","loading");try{i(`Fetching kernel and dash wasm...
`,"info");const[n,t,r]=await Promise.all([fetch(S).then(e=>e.arrayBuffer()),fetch(T).then(e=>e.arrayBuffer()),b(u)]);i(`Kernel: ${(n.byteLength/1024).toFixed(0)}KB, dash: ${(t.byteLength/1024).toFixed(0)}KB, nginx: ${(r/(1024*1024)).toFixed(1)}MB (lazy)
`,"info");const d=[{url:M,path:"/bin/coreutils",symlinks:[...P,"["].flatMap(e=>[`/bin/${e}`,`/usr/bin/${e}`])},{url:z,path:"/usr/bin/grep",symlinks:["/bin/grep","/usr/bin/egrep","/bin/egrep","/usr/bin/fgrep","/bin/fgrep"]},{url:U,path:"/usr/bin/sed",symlinks:["/bin/sed"]}],p=await Promise.all(d.map(e=>b(e.url))),g=[];for(let e=0;e<d.length;e++)p[e]>0&&g.push({...d[e],size:p[e]});s=new v({onStdout:e=>i(y.decode(e)),onStderr:e=>i(y.decode(e),"stderr")}),await s.init(n),i(`Populating filesystem...
`,"info");const a=s.fs;C(s,t,g),r>0&&s.registerLazyFiles([{path:"/usr/sbin/nginx",url:u,size:r,mode:493}]);try{a.mkdir("/usr/sbin",493)}catch{}I(a),L(a,"/var/www/html/index.html",A),f(a,"10-nginx",{type:"daemon",command:"/usr/sbin/nginx -p /etc/nginx -c nginx.conf",ready:"delay:2000",bridge:"8080"}),f(a,"99-shell",{type:"interactive",command:"/bin/dash -i",env:"TERM=xterm-256color PS1=\\w\\$\\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin",pty:"true",cwd:"/root"}),o("Booting system...","loading"),x=new W(s,{onLog:(e,E)=>i(e+`
`,E==="info"?"info":"stderr"),terminalContainer:F,serviceWorkerUrl:$,appPrefix:k,onServiceReady:e=>{e==="nginx"&&(o("nginx is running! Loading page in iframe...","running"),w.disabled=!1,B())}}),await x.boot()}catch(n){i(`
Error: ${n}
`,"stderr"),o(`Error: ${n}`,"error"),console.error(n),m.disabled=!1}}function B(){const n=document.createElement("iframe");n.id="frame",n.src=k,h.replaceWith(n),h=n}m.addEventListener("click",D);w.addEventListener("click",B);
