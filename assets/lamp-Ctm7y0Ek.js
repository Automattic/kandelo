import{k as W,B as C}from"./browser-kernel-DS31Lu-o.js";/* empty css               */import{S as N}from"./terminal-panel-sc5ZsZwc.js";import{n as P,p as M}from"./nginx-Cq4QJjHN.js";import{p as R,a as F}from"./php-fpm-Deu4FVBk.js";import{m as z,s as v,a as G,p as q}from"./mysql_system_tables_data-CJXMtRxP.js";import{C as K,p as V,e as B,b as Y,d as Q,w as g,a as p}from"./shell-binaries-DvtU7PcP.js";import{l as X}from"./wp-bundle-CEfoOdTg.js";import{d as j,c as J,g as Z,s as ee}from"./sed-CaEQBVG8.js";import"./xterm-CyPUMFhC.js";const O="/wasm-posix-kernel/app/",A="/wasm-posix-kernel/app",E=window.location.protocol==="https:"?"https":"http",te="/wasm-posix-kernel/service-worker.js",m=document.getElementById("log"),T=document.getElementById("start"),k=document.getElementById("reload"),h=document.getElementById("status"),ae=document.getElementById("terminal-panel");let $=document.getElementById("frame");const x=new TextDecoder;function s(t,a){const i=document.createElement("span");a&&(i.className=a),i.textContent=t,m.appendChild(i),m.scrollTop=m.scrollHeight}function d(t,a){h.style.display="block",h.textContent=t,h.className=`status ${a}`}const re=`        location / {
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
        }`,se=`<?php
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
    if ('${E}' === 'https') { $_SERVER['HTTPS'] = 'on'; }
    define('WP_HOME', '${E}://' . $_SERVER['HTTP_HOST'] . '${A}');
    define('WP_SITEURL', '${E}://' . $_SERVER['HTTP_HOST'] . '${A}');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`,ne=`<?php
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function($pre, $args, $url) {
    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
}, 10, 3);
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;async function b(t){try{const a=await fetch(t,{method:"HEAD"});return a.ok&&parseInt(a.headers.get("content-length")||"0",10)||0}catch{return 0}}let n=null,L=null;async function ie(){T.disabled=!0,m.textContent="",d("Loading WordPress (LEMP)...","loading");try{s(`Fetching resources...
`,"info");const[t,a,i,U,I,f,c]=await Promise.all([fetch(W).then(e=>e.arrayBuffer()),fetch(z).then(e=>e.arrayBuffer()),fetch(j).then(e=>e.arrayBuffer()),fetch(v).then(e=>e.text()),fetch(G).then(e=>e.text()),b(P),b(R)]);s(`Kernel: ${(t.byteLength/1024).toFixed(0)}KB, MariaDB: ${(a.byteLength/(1024*1024)).toFixed(1)}MB, dash: ${(i.byteLength/1024).toFixed(0)}KB, nginx: ${(f/(1024*1024)).toFixed(1)}MB (lazy), PHP-FPM: ${(c/(1024*1024)).toFixed(1)}MB (lazy)
`,"info");const _=[{url:J,path:"/bin/coreutils",symlinks:[...K,"["].flatMap(e=>[`/bin/${e}`,`/usr/bin/${e}`])},{url:Z,path:"/usr/bin/grep",symlinks:["/bin/grep","/usr/bin/egrep","/bin/egrep","/usr/bin/fgrep","/bin/fgrep"]},{url:ee,path:"/usr/bin/sed",symlinks:["/bin/sed"]}],S=await Promise.all(_.map(e=>b(e.url))),w=[];for(let e=0;e<_.length;e++)S[e]>0&&w.push({..._[e],size:S[e]});n=new C({maxWorkers:16,fsSize:128*1024*1024,onStdout:e=>s(x.decode(e)),onStderr:e=>{const o=x.decode(e);s(o,"stderr"),console.log(`[STDERR] ${o.trim()}`)}}),await n.init(t),s(`Populating filesystem...
`,"info");const r=n.fs;V(n,i,w),B(r,"/usr/sbin"),Y(r,"/usr/sbin/mariadbd",new Uint8Array(a)),q(r);const l=[];f>0&&l.push({path:"/usr/sbin/nginx",url:P,size:f,mode:493}),c>0&&l.push({path:"/usr/sbin/php-fpm",url:R,size:c,mode:493}),l.length>0&&n.registerLazyFiles(l),M(r,{extraLocations:re}),F(r),Q(r,"/var/www/html/wp-content/mu-plugins");const H=`use mysql;
${U}
${I}
CREATE DATABASE IF NOT EXISTS wordpress;
`;B(r,"/etc/mariadb"),g(r,"/etc/mariadb/bootstrap.sql",H),p(r,"05-mariadb-bootstrap",{type:"oneshot",command:"/usr/sbin/mariadbd --no-defaults --bootstrap --datadir=/data --tmpdir=/data/tmp --default-storage-engine=Aria --skip-grant-tables --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 --skip-networking --log-warnings=0 --log-error=/data/bootstrap.log",stdin:"/etc/mariadb/bootstrap.sql",ready:"stdin-consumed",terminate:"true"}),p(r,"10-mariadb",{type:"daemon",command:"/usr/sbin/mariadbd --no-defaults --datadir=/data --tmpdir=/data/tmp --default-storage-engine=Aria --skip-grant-tables --key-buffer-size=1048576 --table-open-cache=10 --sort-buffer-size=262144 --skip-networking=0 --port=3306 --bind-address=0.0.0.0 --socket= --max-connections=10 --thread-handling=no-threads --log-error=/data/error.log",depends:"mariadb-bootstrap",ready:"port:3306"}),p(r,"20-php-fpm",{type:"daemon",command:"/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize",depends:"mariadb",ready:"delay:3000"}),p(r,"30-nginx",{type:"daemon",command:"/usr/sbin/nginx -p /etc/nginx -c nginx.conf",depends:"php-fpm",ready:"delay:2000",bridge:"8080"}),p(r,"99-shell",{type:"interactive",command:"/bin/dash -i",env:"TERM=xterm-256color PS1=\\w\\$\\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin",pty:"true",cwd:"/root"}),d("Booting system...","loading"),L=new N(n,{onLog:(e,o)=>s(e+`
`,o==="info"?"info":"stderr"),terminalContainer:ae,serviceWorkerUrl:te,appPrefix:O,onBeforeService:async e=>{if(e==="shell"){d("Loading WordPress files...","loading");const o=await X(n.fs,"/wasm-posix-kernel/wp-bundle.json",(u,y)=>{(u%500===0||u===y)&&s(`  ${u}/${y} files
`,"info")});s(`WordPress loaded: ${o} files
`,"info");try{n.fs.unlink("/var/www/html/wp-content/db.php")}catch{}g(n.fs,"/var/www/html/wp-config.php",se),g(n.fs,"/var/www/html/wp-content/mu-plugins/wasm-optimizations.php",ne),d("LEMP stack running!","running"),k.disabled=!1,D()}},onServiceReady:e=>{e==="mariadb-bootstrap"&&s(`Bootstrap complete
`,"info")}}),await L.boot()}catch(t){const a=(t==null?void 0:t.message)||String(t);s(`
Error: ${a}
`,"stderr"),d(`Error: ${a}`,"error"),console.error(t),T.disabled=!1}}function D(){const t=document.createElement("iframe");t.id="frame",t.src=O,$.replaceWith(t),$=t}T.addEventListener("click",ie);k.addEventListener("click",D);
