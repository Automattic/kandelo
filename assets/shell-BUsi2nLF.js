import{B as T,k as R}from"./browser-kernel-DeZfH_RD.js";/* empty css               */import{P as O}from"./xterm-CyPUMFhC.js";import{p as F,C as N}from"./shell-binaries-DvtU7PcP.js";import{d as j,c as K,g as q,s as V}from"./sed-CaEQBVG8.js";import{l as G}from"./lsof-D3uw5Gqm.js";const Z="/wasm-posix-kernel/assets/bc-KVYwR7Zy.wasm",_="/wasm-posix-kernel/assets/file-_be0UJNS.wasm",Y="/wasm-posix-kernel/assets/magic-COfg-bwM.lite",J="/wasm-posix-kernel/assets/less-BeqAJbnZ.wasm",Q="/wasm-posix-kernel/assets/m4-dIOGglme.wasm",X="/wasm-posix-kernel/assets/make-Cxi4PLe4.wasm",ee="/wasm-posix-kernel/assets/tar-DMBxRNk3.wasm",te="/wasm-posix-kernel/assets/curl-ChylmRUE.wasm",ne="/wasm-posix-kernel/assets/wget-Bhamrlkv.wasm",se="/wasm-posix-kernel/assets/git-DnnZGZ02.wasm",ie="/wasm-posix-kernel/assets/git-remote-http-CwZvYakx.wasm",ae="/wasm-posix-kernel/assets/gzip-DTDRmS_j.wasm",oe="/wasm-posix-kernel/assets/bzip2-DGINLYWQ.wasm",le="/wasm-posix-kernel/assets/xz-Dv0GQwkt.wasm",re="/wasm-posix-kernel/assets/zstd-Bt8dNWDy.wasm",ce="/wasm-posix-kernel/assets/zip-CcuSMK0h.wasm",me="/wasm-posix-kernel/assets/unzip-C2SP-KgC.wasm",de="/wasm-posix-kernel/assets/nano-taW3i4BM.wasm",ue="/wasm-posix-kernel/assets/vim-BFCk_vo8.wasm",he="/wasm-posix-kernel/assets/vim-runtime-bundle-CAmX6mOc.json",p="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";function pe(e){const n=e.endsWith("==")?2:e.endsWith("=")?1:0,t=new Uint8Array(e.length*3/4-n);let a=0;for(let i=0;i<e.length;i+=4){const o=p.indexOf(e[i]),r=p.indexOf(e[i+1]),s=p.indexOf(e[i+2]),c=p.indexOf(e[i+3]),x=o<<18|r<<12|s<<6|c;t[a++]=x>>16&255,a<t.length&&(t[a++]=x>>8&255),a<t.length&&(t[a++]=x&255)}return t}function be(e,n){const t=n.split("/").filter(Boolean);let a="";for(let i=0;i<t.length-1;i++){a+="/"+t[i];try{e.mkdir(a,493)}catch{}}}async function fe(e,n){const t=await fetch(n);if(!t.ok)return console.warn(`Failed to fetch Vim runtime bundle: ${t.status}`),0;const a=await t.json();for(const i of a.files){const o=pe(i.data);be(e,i.path);const r=e.open(i.path,577,420);e.write(r,o,null,o.length),e.close(r)}return a.files.length}const C=document.getElementById("terminal"),y=document.getElementById("start"),g=document.getElementById("stop"),k=document.getElementById("snippets"),W=document.getElementById("code"),b=document.getElementById("batch-output"),v=document.getElementById("run"),z=document.getElementById("examples"),f=document.getElementById("status"),$=document.getElementById("mode-interactive"),E=document.getElementById("mode-batch"),I=document.getElementById("interactive-view"),A=document.getElementById("batch-view"),we=new TextEncoder;$.addEventListener("click",()=>{$.classList.add("active"),E.classList.remove("active"),I.classList.remove("hidden"),A.classList.add("hidden")});E.addEventListener("click",()=>{E.classList.add("active"),$.classList.remove("active"),A.classList.remove("hidden"),I.classList.add("hidden")});function h(e,n){f.style.display="block",f.textContent=e,f.className=`status ${n}`}function D(){f.style.display="none"}let u=null,m=null,w=[],B=[];async function ye(e){try{const n=await fetch(e,{method:"HEAD"});return n.ok&&parseInt(n.headers.get("content-length")||"0",10)||0}catch{return 0}}async function P(){if(u&&m)return"";h("Loading kernel and dash...","loading");const[e,n]=await Promise.all([fetch(R).then(s=>s.arrayBuffer()),fetch(j).then(s=>s.arrayBuffer())]);u=e,m=n;const t=[{url:K,path:"/bin/coreutils",symlinks:[...N,"["].flatMap(s=>[`/bin/${s}`,`/usr/bin/${s}`])},{url:q,path:"/usr/bin/grep",symlinks:["/bin/grep","/usr/bin/egrep","/bin/egrep","/usr/bin/fgrep","/bin/fgrep"]},{url:V,path:"/usr/bin/sed",symlinks:["/bin/sed"]},{url:Z,path:"/usr/bin/bc",symlinks:["/bin/bc"]},{url:_,path:"/usr/bin/file",symlinks:["/bin/file"]},{url:J,path:"/usr/bin/less",symlinks:["/bin/less"]},{url:Q,path:"/usr/bin/m4",symlinks:["/bin/m4"]},{url:X,path:"/usr/bin/make",symlinks:["/bin/make"]},{url:ee,path:"/usr/bin/tar",symlinks:["/bin/tar"]},{url:te,path:"/usr/bin/curl",symlinks:["/bin/curl"]},{url:ne,path:"/usr/bin/wget",symlinks:["/bin/wget"]},{url:se,path:"/usr/bin/git",symlinks:["/bin/git"]},{url:ie,path:"/usr/bin/git-remote-http",symlinks:["/usr/bin/git-remote-https","/usr/bin/git-remote-ftp","/usr/bin/git-remote-ftps"]},{url:ae,path:"/usr/bin/gzip",symlinks:["/bin/gzip","/usr/bin/gunzip","/bin/gunzip","/usr/bin/zcat","/bin/zcat"]},{url:oe,path:"/usr/bin/bzip2",symlinks:["/bin/bzip2","/usr/bin/bunzip2","/bin/bunzip2","/usr/bin/bzcat","/bin/bzcat"]},{url:le,path:"/usr/bin/xz",symlinks:["/bin/xz","/usr/bin/unxz","/bin/unxz","/usr/bin/xzcat","/bin/xzcat","/usr/bin/lzma","/bin/lzma","/usr/bin/unlzma","/bin/unlzma","/usr/bin/lzcat","/bin/lzcat"]},{url:re,path:"/usr/bin/zstd",symlinks:["/bin/zstd","/usr/bin/unzstd","/bin/unzstd","/usr/bin/zstdcat","/bin/zstdcat"]},{url:ce,path:"/usr/bin/zip",symlinks:["/bin/zip"]},{url:me,path:"/usr/bin/unzip",symlinks:["/bin/unzip","/usr/bin/zipinfo","/bin/zipinfo","/usr/bin/funzip","/bin/funzip"]},{url:G,path:"/usr/bin/lsof",symlinks:["/bin/lsof"]},{url:de,path:"/usr/bin/nano",symlinks:["/bin/nano"]},{url:ue,path:"/usr/bin/vim",symlinks:["/bin/vim","/usr/bin/vi","/bin/vi"]}],a=[{url:Y,path:"/usr/share/misc/magic"}],[i,...o]=await Promise.all([Promise.all(t.map(s=>ye(s.url))),...a.map(async s=>{try{const c=await fetch(s.url);return c.ok?await c.arrayBuffer():null}catch{return null}})]);w=[];for(let s=0;s<t.length;s++)i[s]>0&&w.push({...t[s],size:i[s]});B=[];for(let s=0;s<a.length;s++)o[s]&&B.push({...a[s],data:o[s]});const r=[`Kernel: ${(u.byteLength/1024).toFixed(0)}KB`,`dash: ${(m.byteLength/1024).toFixed(0)}KB`];for(const s of w){const c=s.path.split("/").pop();r.push(`${c}: ${(s.size/(1024*1024)).toFixed(1)}MB (lazy)`)}return r.join(", ")+`
`}async function H(e){const n=e.fs;F(e,m,w,B.filter(o=>o.data).map(o=>({path:o.path,data:new Uint8Array(o.data)})));const a=new TextEncoder().encode(`alias ls='ls --color=auto'
alias grep='grep --color=auto'
`),i=n.open("/etc/profile",577,420);n.write(i,a,null,a.length),n.close(i),await fe(n,he)}let U=null,l=null;async function ge(){y.disabled=!0,g.disabled=!1,C.innerHTML="";try{const e=await P();h("Starting shell...","running");const n=new T({corsProxyUrl:"/cors-proxy?url="});await n.init(u),await H(n),U=n;const t=new O(C,n);l=t,e&&t.terminal.writeln(e.trimEnd()),D(),t.terminal.focus();const a=await t.spawn(m,["dash","-i"],{env:["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin","PS1=$ ","ENV=/etc/profile"]});t.terminal.writeln(`\r
[Shell exited with code ${a}]`)}catch(e){l&&l.terminal.writeln(`\r
Error: ${e}`),h(`Error: ${e}`,"error"),console.error(e)}finally{U=null,y.disabled=!1,g.disabled=!0}}function xe(){l&&(l.terminal.writeln(`\r
[Shell stopped]`),l.dispose(),l=null),U=null,y.disabled=!1,g.disabled=!0}y.addEventListener("click",ge);g.addEventListener("click",xe);k.addEventListener("change",()=>{const e={hello:"echo hello",ls:"ls /tmp",pipe:'echo "hello world" | wc -c',loop:"i=1; while [ $i -le 5 ]; do echo $i; i=$((i+1)); done",files:"echo test > /tmp/f.txt && cat /tmp/f.txt"},n=k.value;n&&e[n]&&l&&l.write(e[n]+`
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
`};function d(e,n){const t=document.createElement("span");n&&(t.className=n),t.textContent=e,b.appendChild(t),b.scrollTop=b.scrollHeight}async function M(){v.disabled=!0,b.textContent="";try{const e=await P();e&&d(e,"info");const n=W.value;h("Running shell...","running");const t=new T({onStdout:i=>d(L.decode(i)),onStderr:i=>d(L.decode(i),"stderr"),corsProxyUrl:"/cors-proxy?url="});await t.init(u),await H(t);const a=await t.spawn(m,["dash"],{env:["HOME=/home","TMPDIR=/tmp","TERM=dumb","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],stdin:we.encode(n)});d(`
Exited with code ${a}
`,"info"),D()}catch(e){d(`
Error: ${e}
`,"stderr"),h(`Error: ${e}`,"error"),console.error(e)}finally{v.disabled=!1}}v.addEventListener("click",M);z.addEventListener("change",()=>{const e=z.value;e&&S[e]&&(W.value=S[e]),z.value=""});W.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),M())});
