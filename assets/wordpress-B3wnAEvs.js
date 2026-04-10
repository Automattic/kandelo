import{k as D,B as U}from"./browser-kernel-DS31Lu-o.js";/* empty css               */import{S as H}from"./terminal-panel-sc5ZsZwc.js";import{n as P,p as k}from"./nginx-B-LiObMC.js";import{p as y,a as v}from"./php-fpm-Deu4FVBk.js";import{C as W,p as C,d as R,a as _,w as L}from"./shell-binaries-DvtU7PcP.js";import{l as N}from"./wp-bundle-CEfoOdTg.js";import{d as F,c as M,g as z,s as G}from"./sed-CaEQBVG8.js";import"./xterm-CyPUMFhC.js";const $="/wasm-posix-kernel/app/",x="/wasm-posix-kernel/app",u=window.location.protocol==="https:"?"https":"http",K="/wasm-posix-kernel/service-worker.js",d=document.getElementById("log"),h=document.getElementById("start"),A=document.getElementById("reload"),E=document.getElementById("status"),V=document.getElementById("terminal-panel");let B=document.getElementById("frame");const b=new TextDecoder;function r(t,n){const a=document.createElement("span");n&&(a.className=n),a.textContent=t,d.appendChild(a),d.scrollTop=d.scrollHeight}function o(t,n){E.style.display="block",E.textContent=t,E.className=`status ${n}`}const Y=`        location / {
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
        }`,q=`<?php
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
    if ('${u}' === 'https') { $_SERVER['HTTPS'] = 'on'; }
    define('WP_HOME', '${u}://' . $_SERVER['HTTP_HOST'] . '${x}');
    define('WP_SITEURL', '${u}://' . $_SERVER['HTTP_HOST'] . '${x}');
}

define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);

if ( ! defined( 'ABSPATH' ) ) {
    define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
`,Q=`<?php
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function($pre, $args, $url) {
    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
}, 10, 3);
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;async function g(t){try{const n=await fetch(t,{method:"HEAD"});return n.ok&&parseInt(n.headers.get("content-length")||"0",10)||0}catch{return 0}}let s=null,O=null;async function j(){h.disabled=!0,d.textContent="",o("Loading WordPress...","loading");try{r(`Fetching kernel and dash wasm...
`,"info");const[t,n,a,l]=await Promise.all([fetch(D).then(e=>e.arrayBuffer()),fetch(F).then(e=>e.arrayBuffer()),g(P),g(y)]);r(`Kernel: ${(t.byteLength/1024).toFixed(0)}KB, dash: ${(n.byteLength/1024).toFixed(0)}KB, nginx: ${(a/(1024*1024)).toFixed(1)}MB (lazy), PHP-FPM: ${(l/(1024*1024)).toFixed(1)}MB (lazy)
`,"info");const f=[{url:M,path:"/bin/coreutils",symlinks:[...W,"["].flatMap(e=>[`/bin/${e}`,`/usr/bin/${e}`])},{url:z,path:"/usr/bin/grep",symlinks:["/bin/grep","/usr/bin/egrep","/bin/egrep","/usr/bin/fgrep","/bin/fgrep"]},{url:G,path:"/usr/bin/sed",symlinks:["/bin/sed"]}],w=await Promise.all(f.map(e=>g(e.url))),T=[];for(let e=0;e<f.length;e++)w[e]>0&&T.push({...f[e],size:w[e]});s=new U({maxWorkers:8,fsSize:256*1024*1024,maxMemoryPages:4096,onStdout:e=>r(b.decode(e)),onStderr:e=>r(b.decode(e),"stderr")}),await s.init(t),r(`Populating filesystem...
`,"info");const i=s.fs;C(s,n,T);const p=[];a>0&&p.push({path:"/usr/sbin/nginx",url:P,size:a,mode:493}),l>0&&p.push({path:"/usr/sbin/php-fpm",url:y,size:l,mode:493}),p.length>0&&s.registerLazyFiles(p);try{i.mkdir("/usr/sbin",493)}catch{}k(i,{extraLocations:Y}),v(i),R(i,"/var/www/html/wp-content/database"),R(i,"/var/www/html/wp-content/mu-plugins"),_(i,"10-php-fpm",{type:"daemon",command:"/usr/sbin/php-fpm -y /etc/php-fpm.conf -c /dev/null --nodaemonize",ready:"delay:5000"}),_(i,"20-nginx",{type:"daemon",command:"/usr/sbin/nginx -p /etc/nginx -c nginx.conf",depends:"php-fpm",ready:"delay:3000",bridge:"8080"}),_(i,"99-shell",{type:"interactive",command:"/bin/dash -i",env:"TERM=xterm-256color PS1=\\w\\$\\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin",pty:"true",cwd:"/root"}),o("Booting system...","loading"),O=new H(s,{onLog:(e,m)=>r(e+`
`,m==="info"?"info":"stderr"),terminalContainer:V,serviceWorkerUrl:K,appPrefix:$,onBeforeService:async e=>{if(e==="shell"){o("Loading WordPress files...","loading");const m=await N(s.fs,"/wasm-posix-kernel/wp-bundle.json",(c,S)=>{(c%500===0||c===S)&&r(`  ${c}/${S} files
`,"info")});r(`WordPress loaded: ${m} files
`,"info");try{s.fs.unlink("/var/www/html/wp-content/database/wordpress.db")}catch{}L(s.fs,"/var/www/html/wp-config.php",q),L(s.fs,"/var/www/html/wp-content/mu-plugins/wasm-optimizations.php",Q)}},onServiceReady:e=>{e==="nginx"&&(o("WordPress running! Loading page...","running"),A.disabled=!1,I())}}),await O.boot()}catch(t){r(`
Error: ${t}
`,"stderr"),o(`Error: ${t}`,"error"),console.error(t),h.disabled=!1}}function I(){const t=document.createElement("iframe");t.id="frame",t.src=$,B.replaceWith(t),B=t}h.addEventListener("click",j);A.addEventListener("click",I);
