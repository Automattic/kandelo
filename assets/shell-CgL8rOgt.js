import{B as T,k as R}from"./browser-kernel-DS31Lu-o.js";/* empty css               */import{P as O}from"./xterm-CyPUMFhC.js";import{p as F,C as j}from"./shell-binaries-DvtU7PcP.js";import{d as N,c as K,g as V,s as q}from"./sed-CaEQBVG8.js";import{l as G}from"./lsof-D3uw5Gqm.js";const Z="/wasm-posix-kernel/assets/bc-KVYwR7Zy.wasm",_="/wasm-posix-kernel/assets/file-_be0UJNS.wasm",Y="/wasm-posix-kernel/assets/magic-COfg-bwM.lite",J="/wasm-posix-kernel/assets/less-BeqAJbnZ.wasm",Q="/wasm-posix-kernel/assets/m4-dIOGglme.wasm",X="/wasm-posix-kernel/assets/make-Cxi4PLe4.wasm",ee="/wasm-posix-kernel/assets/tar-DMBxRNk3.wasm",te="/wasm-posix-kernel/assets/curl-ChylmRUE.wasm",ne="/wasm-posix-kernel/assets/wget-Bhamrlkv.wasm",se="/wasm-posix-kernel/assets/git-DnnZGZ02.wasm",ie="/wasm-posix-kernel/assets/git-remote-http-CwZvYakx.wasm",ae="/wasm-posix-kernel/assets/gzip-DTDRmS_j.wasm",oe="/wasm-posix-kernel/assets/bzip2-DGINLYWQ.wasm",le="/wasm-posix-kernel/assets/xz-Dv0GQwkt.wasm",re="/wasm-posix-kernel/assets/zstd-Bt8dNWDy.wasm",ce="/wasm-posix-kernel/assets/zip-CcuSMK0h.wasm",me="/wasm-posix-kernel/assets/unzip-C2SP-KgC.wasm",de="/wasm-posix-kernel/assets/nano-taW3i4BM.wasm",he="/wasm-posix-kernel/assets/vim-BFCk_vo8.wasm",ue="/wasm-posix-kernel/assets/vim-runtime-bundle-CAmX6mOc.json",p="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";function pe(e){const t=e.endsWith("==")?2:e.endsWith("=")?1:0,n=new Uint8Array(e.length*3/4-t);let a=0;for(let i=0;i<e.length;i+=4){const c=p.indexOf(e[i]),l=p.indexOf(e[i+1]),s=p.indexOf(e[i+2]),o=p.indexOf(e[i+3]),x=c<<18|l<<12|s<<6|o;n[a++]=x>>16&255,a<n.length&&(n[a++]=x>>8&255),a<n.length&&(n[a++]=x&255)}return n}function be(e,t){const n=t.split("/").filter(Boolean);let a="";for(let i=0;i<n.length-1;i++){a+="/"+n[i];try{e.mkdir(a,493)}catch{}}}async function fe(e,t){const n=await fetch(t);if(!n.ok)return console.warn(`Failed to fetch Vim runtime bundle: ${n.status}`),0;const a=await n.json();for(const i of a.files){const c=pe(i.data);be(e,i.path);const l=e.open(i.path,577,420);e.write(l,c,null,c.length),e.close(l)}return a.files.length}const C=document.getElementById("terminal"),y=document.getElementById("start"),g=document.getElementById("stop"),k=document.getElementById("snippets"),W=document.getElementById("code"),b=document.getElementById("batch-output"),v=document.getElementById("run"),z=document.getElementById("examples"),f=document.getElementById("status"),$=document.getElementById("mode-interactive"),E=document.getElementById("mode-batch"),I=document.getElementById("interactive-view"),A=document.getElementById("batch-view"),we=new TextEncoder;$.addEventListener("click",()=>{$.classList.add("active"),E.classList.remove("active"),I.classList.remove("hidden"),A.classList.add("hidden")});E.addEventListener("click",()=>{E.classList.add("active"),$.classList.remove("active"),A.classList.remove("hidden"),I.classList.add("hidden")});function u(e,t){f.style.display="block",f.textContent=e,f.className=`status ${t}`}function D(){f.style.display="none"}let h=null,m=null,w=[],B=[];async function ye(e){try{const t=await fetch(e,{method:"HEAD"});return t.ok&&parseInt(t.headers.get("content-length")||"0",10)||0}catch{return 0}}async function H(){if(h&&m)return"";u("Loading kernel and dash...","loading");const[e,t]=await Promise.all([fetch(R).then(s=>s.arrayBuffer()),fetch(N).then(s=>s.arrayBuffer())]);h=e,m=t;const n=[{url:K,path:"/bin/coreutils",symlinks:[...j,"["].flatMap(s=>[`/bin/${s}`,`/usr/bin/${s}`])},{url:V,path:"/usr/bin/grep",symlinks:["/bin/grep","/usr/bin/egrep","/bin/egrep","/usr/bin/fgrep","/bin/fgrep"]},{url:q,path:"/usr/bin/sed",symlinks:["/bin/sed"]},{url:Z,path:"/usr/bin/bc",symlinks:["/bin/bc"]},{url:_,path:"/usr/bin/file",symlinks:["/bin/file"]},{url:J,path:"/usr/bin/less",symlinks:["/bin/less"]},{url:Q,path:"/usr/bin/m4",symlinks:["/bin/m4"]},{url:X,path:"/usr/bin/make",symlinks:["/bin/make"]},{url:ee,path:"/usr/bin/tar",symlinks:["/bin/tar"]},{url:te,path:"/usr/bin/curl",symlinks:["/bin/curl"]},{url:ne,path:"/usr/bin/wget",symlinks:["/bin/wget"]},{url:se,path:"/usr/bin/git",symlinks:["/bin/git"]},{url:ie,path:"/usr/bin/git-remote-http",symlinks:["/usr/bin/git-remote-https","/usr/bin/git-remote-ftp","/usr/bin/git-remote-ftps"]},{url:ae,path:"/usr/bin/gzip",symlinks:["/bin/gzip","/usr/bin/gunzip","/bin/gunzip","/usr/bin/zcat","/bin/zcat"]},{url:oe,path:"/usr/bin/bzip2",symlinks:["/bin/bzip2","/usr/bin/bunzip2","/bin/bunzip2","/usr/bin/bzcat","/bin/bzcat"]},{url:le,path:"/usr/bin/xz",symlinks:["/bin/xz","/usr/bin/unxz","/bin/unxz","/usr/bin/xzcat","/bin/xzcat","/usr/bin/lzma","/bin/lzma","/usr/bin/unlzma","/bin/unlzma","/usr/bin/lzcat","/bin/lzcat"]},{url:re,path:"/usr/bin/zstd",symlinks:["/bin/zstd","/usr/bin/unzstd","/bin/unzstd","/usr/bin/zstdcat","/bin/zstdcat"]},{url:ce,path:"/usr/bin/zip",symlinks:["/bin/zip"]},{url:me,path:"/usr/bin/unzip",symlinks:["/bin/unzip","/usr/bin/zipinfo","/bin/zipinfo","/usr/bin/funzip","/bin/funzip"]},{url:G,path:"/usr/bin/lsof",symlinks:["/bin/lsof"]},{url:de,path:"/usr/bin/nano",symlinks:["/bin/nano"]},{url:he,path:"/usr/bin/vim",symlinks:["/bin/vim","/usr/bin/vi","/bin/vi"]}],a=[{url:Y,path:"/usr/share/misc/magic"}],[i,...c]=await Promise.all([Promise.all(n.map(s=>ye(s.url))),...a.map(async s=>{try{const o=await fetch(s.url);return o.ok?await o.arrayBuffer():null}catch{return null}})]);w=[];for(let s=0;s<n.length;s++)i[s]>0&&w.push({...n[s],size:i[s]});B=[];for(let s=0;s<a.length;s++)c[s]&&B.push({...a[s],data:c[s]});const l=[`Kernel: ${(h.byteLength/1024).toFixed(0)}KB`,`dash: ${(m.byteLength/1024).toFixed(0)}KB`];for(const s of w){const o=s.path.split("/").pop();l.push(`${o}: ${(s.size/(1024*1024)).toFixed(1)}MB (lazy)`)}return l.join(", ")+`
`}async function P(e){const t=e.fs;F(e,m,w,B.filter(o=>o.data).map(o=>({path:o.path,data:new Uint8Array(o.data)})));const n=['[url "http://"]',"	insteadOf = https://","[http]","	sslVerify = false",""].join(`
`),a=new TextEncoder().encode(n),i=t.open("/etc/gitconfig",1025,420);t.write(i,a,null,a.length),t.close(i);const l=new TextEncoder().encode(`alias ls='ls --color=auto'
alias grep='grep --color=auto'
`),s=t.open("/etc/profile",577,420);t.write(s,l,null,l.length),t.close(s),await fe(t,ue)}let U=null,r=null;async function ge(){y.disabled=!0,g.disabled=!1,C.innerHTML="";try{const e=await H();u("Starting shell...","running");const t=new T({corsProxyUrl:"https://wordpress-playground-cors-proxy.net/?"});await t.init(h),await P(t),U=t;const n=new O(C,t);r=n,e&&n.terminal.writeln(e.trimEnd()),D(),n.terminal.focus();const a=await n.spawn(m,["dash","-i"],{env:["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin","PS1=$ ","ENV=/etc/profile"]});n.terminal.writeln(`\r
[Shell exited with code ${a}]`)}catch(e){r&&r.terminal.writeln(`\r
Error: ${e}`),u(`Error: ${e}`,"error"),console.error(e)}finally{U=null,y.disabled=!1,g.disabled=!0}}function xe(){r&&(r.terminal.writeln(`\r
[Shell stopped]`),r.dispose(),r=null),U=null,y.disabled=!1,g.disabled=!0}y.addEventListener("click",ge);g.addEventListener("click",xe);k.addEventListener("change",()=>{const e={hello:"echo hello",ls:"ls /tmp",pipe:'echo "hello world" | wc -c',loop:"i=1; while [ $i -le 5 ]; do echo $i; i=$((i+1)); done",files:"echo test > /tmp/f.txt && cat /tmp/f.txt"},t=k.value;t&&e[t]&&r&&r.write(e[t]+`
`),k.value=""});const L=new TextDecoder,S={hello:`echo "Hello from dash on WebAssembly!"
echo "Shell: dash (Debian Almquist Shell)"
uname -a
echo "Current directory: $(pwd)"
echo "Home: $HOME"
echo "Path: $PATH"
`,pipes:`echo "Pipe examples:"
echo "---"

echo "Word frequency in a sentence:"
echo "the quick brown fox jumps over the lazy dog the fox" | tr ' ' '\\n' | sort | uniq -c | sort -rn

echo ""
echo "First 5 lines of sorted env:"
env | sort | head -5

echo ""
echo "Character count:"
echo "Hello, WebAssembly!" | wc -c
`,loops:`echo "Counting to 10:"
i=1
while [ $i -le 10 ]; do
  printf "%d " $i
  i=$((i + 1))
done
echo ""

echo ""
echo "Multiplication table (1-5):"
i=1
while [ $i -le 5 ]; do
  j=1
  while [ $j -le 5 ]; do
    printf "%4d" $((i * j))
    j=$((j + 1))
  done
  echo ""
  i=$((i + 1))
done

echo ""
echo "Fibonacci sequence:"
a=0
b=1
n=0
while [ $n -lt 15 ]; do
  printf "%d " $a
  c=$((a + b))
  a=$b
  b=$c
  n=$((n + 1))
done
echo ""
`,files:`echo "File operations in the virtual filesystem:"
echo "---"

mkdir -p /tmp/demo
echo "Created /tmp/demo"

echo "Hello from WebAssembly" > /tmp/demo/hello.txt
echo "This is line 2" >> /tmp/demo/hello.txt
echo "This is line 3" >> /tmp/demo/hello.txt

echo ""
echo "Contents of /tmp/demo/hello.txt:"
cat /tmp/demo/hello.txt

echo ""
echo "Line count:"
wc -l /tmp/demo/hello.txt

echo ""
echo "Reversed:"
tac /tmp/demo/hello.txt

echo ""
echo "Creating more files..."
echo "alpha" > /tmp/demo/a.txt
echo "bravo" > /tmp/demo/b.txt
echo "charlie" > /tmp/demo/c.txt

echo "Concatenated:"
cat /tmp/demo/a.txt /tmp/demo/b.txt /tmp/demo/c.txt
`,text:`echo "Text processing with coreutils:"
echo "---"

echo "Cut fields from CSV:"
printf "name,age,city\\nAlice,30,NYC\\nBob,25,LA\\nCharlie,35,Chicago\\n" | cut -d, -f1,3

echo ""
echo "Sort and unique:"
printf "banana\\napple\\ncherry\\napple\\nbanana\\ndate\\n" | sort | uniq

echo ""
echo "Translate characters:"
echo "Hello World" | tr '[:lower:]' '[:upper:]'
echo "HELLO WORLD" | tr '[:upper:]' '[:lower:]'

echo ""
echo "Head and tail:"
i=1
while [ $i -le 10 ]; do
  echo "line $i"
  i=$((i + 1))
done > /tmp/lines.txt
echo "First 3 lines:"
head -3 /tmp/lines.txt
echo "Last 3 lines:"
tail -3 /tmp/lines.txt
`,subshell:`echo "Subshells and variables:"
echo "---"

echo "Command substitution:"
echo "Basename: $(basename /usr/local/bin/program)"
echo "Dirname: $(dirname /usr/local/bin/program)"

echo ""
echo "Variable operations:"
greeting="Hello, WebAssembly"
echo "$greeting"

echo ""
echo "Arithmetic:"
a=42
b=13
echo "$a + $b = $((a + b))"
echo "$a - $b = $((a - b))"
echo "$a * $b = $((a * b))"
echo "$a / $b = $((a / b))"
echo "$a % $b = $((a % b))"

echo ""
echo "Conditional:"
if [ 42 -gt 13 ]; then
  echo "42 is greater than 13"
fi

echo ""
echo "Exit status:"
true && echo "true succeeded (exit 0)"
false || echo "false failed (exit 1)"
`};function d(e,t){const n=document.createElement("span");t&&(n.className=t),n.textContent=e,b.appendChild(n),b.scrollTop=b.scrollHeight}async function M(){v.disabled=!0,b.textContent="";try{const e=await H();e&&d(e,"info");const t=W.value;u("Running shell...","running");const n=new T({onStdout:i=>d(L.decode(i)),onStderr:i=>d(L.decode(i),"stderr"),corsProxyUrl:"https://wordpress-playground-cors-proxy.net/?"});await n.init(h),await P(n);const a=await n.spawn(m,["dash"],{env:["HOME=/home","TMPDIR=/tmp","TERM=dumb","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],stdin:we.encode(t)});d(`
Exited with code ${a}
`,"info"),D()}catch(e){d(`
Error: ${e}
`,"stderr"),u(`Error: ${e}`,"error"),console.error(e)}finally{v.disabled=!1}}v.addEventListener("click",M);z.addEventListener("change",()=>{const e=z.value;e&&S[e]&&(W.value=S[e]),z.value=""});W.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),M())});
