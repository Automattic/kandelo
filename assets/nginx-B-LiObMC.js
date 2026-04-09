import{d as r,w as i}from"./shell-binaries-DvtU7PcP.js";function a(t={}){const e=t.port??8080,n=t.root??"/var/www/html",s=t.workerProcesses??2,o=t.extraLocations??"";return`daemon off;
master_process on;
worker_processes ${s};
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
        listen ${e};
        server_name localhost;
        root ${n};
        index index.html;

        location / {
        }
${o?`
`+o+`
`:""}    }
}
`}function p(t,e){const n=["/etc/nginx","/var/www/html","/var/log/nginx","/tmp/nginx_client_temp","/tmp/nginx-wasm/logs"];for(const s of n)r(t,s);i(t,"/etc/nginx/nginx.conf",a(e))}const l="/wasm-posix-kernel/assets/nginx-4p5Zt3rr.wasm";export{l as n,p};
