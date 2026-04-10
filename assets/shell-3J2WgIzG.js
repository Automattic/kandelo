import{B as C,k as D}from"./browser-kernel-DS31Lu-o.js";/* empty css               */import{P as M}from"./xterm-CyPUMFhC.js";import{p as R,C as F}from"./shell-binaries-DvtU7PcP.js";import{d as N,c as O,g as K,s as j}from"./sed-C3GaF0T-.js";import{l as q}from"./lsof-D3uw5Gqm.js";const V="/wasm-posix-kernel/assets/bc-KVYwR7Zy.wasm",G="/wasm-posix-kernel/assets/file-_be0UJNS.wasm",Z="/wasm-posix-kernel/assets/magic-COfg-bwM.lite",_="/wasm-posix-kernel/assets/less-BeqAJbnZ.wasm",Y="/wasm-posix-kernel/assets/m4-dIOGglme.wasm",J="/wasm-posix-kernel/assets/make-Cxi4PLe4.wasm",Q="/wasm-posix-kernel/assets/tar-DMBxRNk3.wasm",X="/wasm-posix-kernel/assets/curl-ChylmRUE.wasm",ee="/wasm-posix-kernel/assets/wget-Bhamrlkv.wasm",te="/wasm-posix-kernel/assets/git-DnnZGZ02.wasm",se="/wasm-posix-kernel/assets/git-remote-http-CwZvYakx.wasm",ne="/wasm-posix-kernel/assets/gzip-DTDRmS_j.wasm",ie="/wasm-posix-kernel/assets/bzip2-DGINLYWQ.wasm",ae="/wasm-posix-kernel/assets/xz-Dv0GQwkt.wasm",oe="/wasm-posix-kernel/assets/zstd-Bt8dNWDy.wasm",le="/wasm-posix-kernel/assets/zip-CcuSMK0h.wasm",re="/wasm-posix-kernel/assets/unzip-C2SP-KgC.wasm",ce="/wasm-posix-kernel/assets/nano-taW3i4BM.wasm",U=document.getElementById("terminal"),f=document.getElementById("start"),w=document.getElementById("stop"),g=document.getElementById("snippets"),B=document.getElementById("code"),p=document.getElementById("batch-output"),k=document.getElementById("run"),x=document.getElementById("examples"),u=document.getElementById("status"),z=document.getElementById("mode-interactive"),$=document.getElementById("mode-batch"),S=document.getElementById("interactive-view"),T=document.getElementById("batch-view"),me=new TextEncoder;z.addEventListener("click",()=>{z.classList.add("active"),$.classList.remove("active"),S.classList.remove("hidden"),T.classList.add("hidden")});$.addEventListener("click",()=>{$.classList.add("active"),z.classList.remove("active"),T.classList.remove("hidden"),S.classList.add("hidden")});function h(e,s){u.style.display="block",u.textContent=e,u.className=`status ${s}`}function I(){u.style.display="none"}let d=null,r=null,b=[],E=[];async function de(e){try{const s=await fetch(e,{method:"HEAD"});return s.ok&&parseInt(s.headers.get("content-length")||"0",10)||0}catch{return 0}}async function H(){if(d&&r)return"";h("Loading kernel and dash...","loading");const[e,s]=await Promise.all([fetch(D).then(t=>t.arrayBuffer()),fetch(N).then(t=>t.arrayBuffer())]);d=e,r=s;const n=[{url:O,path:"/bin/coreutils",symlinks:[...F,"["].flatMap(t=>[`/bin/${t}`,`/usr/bin/${t}`])},{url:K,path:"/usr/bin/grep",symlinks:["/bin/grep","/usr/bin/egrep","/bin/egrep","/usr/bin/fgrep","/bin/fgrep"]},{url:j,path:"/usr/bin/sed",symlinks:["/bin/sed"]},{url:V,path:"/usr/bin/bc",symlinks:["/bin/bc"]},{url:G,path:"/usr/bin/file",symlinks:["/bin/file"]},{url:_,path:"/usr/bin/less",symlinks:["/bin/less"]},{url:Y,path:"/usr/bin/m4",symlinks:["/bin/m4"]},{url:J,path:"/usr/bin/make",symlinks:["/bin/make"]},{url:Q,path:"/usr/bin/tar",symlinks:["/bin/tar"]},{url:X,path:"/usr/bin/curl",symlinks:["/bin/curl"]},{url:ee,path:"/usr/bin/wget",symlinks:["/bin/wget"]},{url:te,path:"/usr/bin/git",symlinks:["/bin/git"]},{url:se,path:"/usr/bin/git-remote-http",symlinks:["/usr/bin/git-remote-https","/usr/bin/git-remote-ftp","/usr/bin/git-remote-ftps"]},{url:ne,path:"/usr/bin/gzip",symlinks:["/bin/gzip","/usr/bin/gunzip","/bin/gunzip","/usr/bin/zcat","/bin/zcat"]},{url:ie,path:"/usr/bin/bzip2",symlinks:["/bin/bzip2","/usr/bin/bunzip2","/bin/bunzip2","/usr/bin/bzcat","/bin/bzcat"]},{url:ae,path:"/usr/bin/xz",symlinks:["/bin/xz","/usr/bin/unxz","/bin/unxz","/usr/bin/xzcat","/bin/xzcat","/usr/bin/lzma","/bin/lzma","/usr/bin/unlzma","/bin/unlzma","/usr/bin/lzcat","/bin/lzcat"]},{url:oe,path:"/usr/bin/zstd",symlinks:["/bin/zstd","/usr/bin/unzstd","/bin/unzstd","/usr/bin/zstdcat","/bin/zstdcat"]},{url:le,path:"/usr/bin/zip",symlinks:["/bin/zip"]},{url:re,path:"/usr/bin/unzip",symlinks:["/bin/unzip","/usr/bin/zipinfo","/bin/zipinfo","/usr/bin/funzip","/bin/funzip"]},{url:q,path:"/usr/bin/lsof",symlinks:["/bin/lsof"]},{url:ce,path:"/usr/bin/nano",symlinks:["/bin/nano"]}],i=[{url:Z,path:"/usr/share/misc/magic"}],[a,...y]=await Promise.all([Promise.all(n.map(t=>de(t.url))),...i.map(async t=>{try{const o=await fetch(t.url);return o.ok?await o.arrayBuffer():null}catch{return null}})]);b=[];for(let t=0;t<n.length;t++)a[t]>0&&b.push({...n[t],size:a[t]});E=[];for(let t=0;t<i.length;t++)y[t]&&E.push({...i[t],data:y[t]});const c=[`Kernel: ${(d.byteLength/1024).toFixed(0)}KB`,`dash: ${(r.byteLength/1024).toFixed(0)}KB`];for(const t of b){const o=t.path.split("/").pop();c.push(`${o}: ${(t.size/(1024*1024)).toFixed(1)}MB (lazy)`)}return c.join(", ")+`
`}function P(e){const s=e.fs;R(e,r,b,E.filter(o=>o.data).map(o=>({path:o.path,data:new Uint8Array(o.data)})));const n=['[url "http://"]',"	insteadOf = https://","[http]","	sslVerify = false",""].join(`
`),i=new TextEncoder().encode(n),a=s.open("/etc/gitconfig",1025,420);s.write(a,i,null,i.length),s.close(a);const c=new TextEncoder().encode(`alias ls='ls --color=auto'
alias grep='grep --color=auto'
`),t=s.open("/etc/profile",577,420);s.write(t,c,null,c.length),s.close(t)}let v=null,l=null;async function he(){f.disabled=!0,w.disabled=!1,U.innerHTML="";try{const e=await H();h("Starting shell...","running");const s=new C({corsProxyUrl:"https://wordpress-playground-cors-proxy.net/?"});await s.init(d),P(s),v=s;const n=new M(U,s);l=n,e&&n.terminal.writeln(e.trimEnd()),I(),n.terminal.focus();const i=await n.spawn(r,["dash","-i"],{env:["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin","PS1=$ ","ENV=/etc/profile"]});n.terminal.writeln(`\r
[Shell exited with code ${i}]`)}catch(e){l&&l.terminal.writeln(`\r
Error: ${e}`),h(`Error: ${e}`,"error"),console.error(e)}finally{v=null,f.disabled=!1,w.disabled=!0}}function pe(){l&&(l.terminal.writeln(`\r
[Shell stopped]`),l.dispose(),l=null),v=null,f.disabled=!1,w.disabled=!0}f.addEventListener("click",he);w.addEventListener("click",pe);g.addEventListener("change",()=>{const e={hello:"echo hello",ls:"ls /tmp",pipe:'echo "hello world" | wc -c',loop:"i=1; while [ $i -le 5 ]; do echo $i; i=$((i+1)); done",files:"echo test > /tmp/f.txt && cat /tmp/f.txt"},s=g.value;s&&e[s]&&l&&l.write(e[s]+`
`),g.value=""});const W=new TextDecoder,L={hello:`echo "Hello from dash on WebAssembly!"
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
`};function m(e,s){const n=document.createElement("span");s&&(n.className=s),n.textContent=e,p.appendChild(n),p.scrollTop=p.scrollHeight}async function A(){k.disabled=!0,p.textContent="";try{const e=await H();e&&m(e,"info");const s=B.value;h("Running shell...","running");const n=new C({onStdout:a=>m(W.decode(a)),onStderr:a=>m(W.decode(a),"stderr"),corsProxyUrl:"https://wordpress-playground-cors-proxy.net/?"});await n.init(d),P(n);const i=await n.spawn(r,["dash"],{env:["HOME=/home","TMPDIR=/tmp","TERM=dumb","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],stdin:me.encode(s)});m(`
Exited with code ${i}
`,"info"),I()}catch(e){m(`
Error: ${e}
`,"stderr"),h(`Error: ${e}`,"error"),console.error(e)}finally{k.disabled=!1}}k.addEventListener("click",A);x.addEventListener("change",()=>{const e=x.value;e&&L[e]&&(B.value=L[e]),x.value=""});B.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),A())});
