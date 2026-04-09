import{B as S,k as R}from"./browser-kernel-CeVfDkIW.js";/* empty css               */import{P as D}from"./xterm-CyPUMFhC.js";import{p as F,C as O}from"./shell-binaries-DvtU7PcP.js";import{d as N,c as q,g as z,s as K}from"./sed-C3GaF0T-.js";import{l as j}from"./lsof-D3uw5Gqm.js";const V="/wasm-posix-kernel/assets/bc-KVYwR7Zy.wasm",_="/wasm-posix-kernel/assets/file-_be0UJNS.wasm",G="/wasm-posix-kernel/assets/magic-COfg-bwM.lite",J="/wasm-posix-kernel/assets/less-BeqAJbnZ.wasm",Y="/wasm-posix-kernel/assets/m4-dIOGglme.wasm",Z="/wasm-posix-kernel/assets/make-Cxi4PLe4.wasm",X="/wasm-posix-kernel/assets/tar-DMBxRNk3.wasm",Q="/wasm-posix-kernel/assets/curl-ChylmRUE.wasm",ee="/wasm-posix-kernel/assets/wget-Bhamrlkv.wasm",te="/wasm-posix-kernel/assets/git-DBunwiaM.wasm",ne="/wasm-posix-kernel/assets/nano-taW3i4BM.wasm",C=document.getElementById("terminal"),f=document.getElementById("start"),w=document.getElementById("stop"),y=document.getElementById("snippets"),B=document.getElementById("code"),u=document.getElementById("batch-output"),x=document.getElementById("run"),g=document.getElementById("examples"),p=document.getElementById("status"),$=document.getElementById("mode-interactive"),k=document.getElementById("mode-batch"),T=document.getElementById("interactive-view"),I=document.getElementById("batch-view"),se=new TextEncoder;$.addEventListener("click",()=>{$.classList.add("active"),k.classList.remove("active"),T.classList.remove("hidden"),I.classList.add("hidden")});k.addEventListener("click",()=>{k.classList.add("active"),$.classList.remove("active"),I.classList.remove("hidden"),T.classList.add("hidden")});function d(e,n){p.style.display="block",p.textContent=e,p.className=`status ${n}`}function A(){p.style.display="none"}let m=null,r=null,b=[],E=[];async function oe(e){try{const n=await fetch(e,{method:"HEAD"});return n.ok&&parseInt(n.headers.get("content-length")||"0",10)||0}catch{return 0}}async function M(){if(m&&r)return"";d("Loading kernel and dash...","loading");const[e,n]=await Promise.all([fetch(R).then(t=>t.arrayBuffer()),fetch(N).then(t=>t.arrayBuffer())]);m=e,r=n;const s=[{url:q,path:"/bin/coreutils",symlinks:[...O,"["].flatMap(t=>[`/bin/${t}`,`/usr/bin/${t}`])},{url:z,path:"/usr/bin/grep",symlinks:["/bin/grep","/usr/bin/egrep","/bin/egrep","/usr/bin/fgrep","/bin/fgrep"]},{url:K,path:"/usr/bin/sed",symlinks:["/bin/sed"]},{url:V,path:"/usr/bin/bc",symlinks:["/bin/bc"]},{url:_,path:"/usr/bin/file",symlinks:["/bin/file"]},{url:J,path:"/usr/bin/less",symlinks:["/bin/less"]},{url:Y,path:"/usr/bin/m4",symlinks:["/bin/m4"]},{url:Z,path:"/usr/bin/make",symlinks:["/bin/make"]},{url:X,path:"/usr/bin/tar",symlinks:["/bin/tar"]},{url:Q,path:"/usr/bin/curl",symlinks:["/bin/curl"]},{url:ee,path:"/usr/bin/wget",symlinks:["/bin/wget"]},{url:te,path:"/usr/bin/git",symlinks:["/bin/git"]},{url:j,path:"/usr/bin/lsof",symlinks:["/bin/lsof"]},{url:ne,path:"/usr/bin/nano",symlinks:["/bin/nano"]}],o=[{url:G,path:"/usr/share/misc/magic"}],[a,...l]=await Promise.all([Promise.all(s.map(t=>oe(t.url))),...o.map(async t=>{try{const h=await fetch(t.url);return h.ok?await h.arrayBuffer():null}catch{return null}})]);b=[];for(let t=0;t<s.length;t++)a[t]>0&&b.push({...s[t],size:a[t]});E=[];for(let t=0;t<o.length;t++)l[t]&&E.push({...o[t],data:l[t]});const L=[`Kernel: ${(m.byteLength/1024).toFixed(0)}KB`,`dash: ${(r.byteLength/1024).toFixed(0)}KB`];for(const t of b){const h=t.path.split("/").pop();L.push(`${h}: ${(t.size/(1024*1024)).toFixed(1)}MB (lazy)`)}return L.join(", ")+`
`}function H(e){const n=e.fs;F(e,r,b,E.filter(l=>l.data).map(l=>({path:l.path,data:new Uint8Array(l.data)})));const o=new TextEncoder().encode(`alias ls='ls --color=auto'
alias grep='grep --color=auto'
`),a=n.open("/etc/profile",577,420);n.write(a,o,null,o.length),n.close(a)}let v=null,i=null;async function ae(){f.disabled=!0,w.disabled=!1,C.innerHTML="";try{const e=await M();d("Starting shell...","running");const n=new S;await n.init(m),H(n),v=n;const s=new D(C,n);i=s,e&&s.terminal.writeln(e.trimEnd()),A(),s.terminal.focus();const o=await s.spawn(r,["dash","-i"],{env:["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin","PS1=$ ","ENV=/etc/profile"]});s.terminal.writeln(`\r
[Shell exited with code ${o}]`)}catch(e){i&&i.terminal.writeln(`\r
Error: ${e}`),d(`Error: ${e}`,"error"),console.error(e)}finally{v=null,f.disabled=!1,w.disabled=!0}}function ie(){i&&(i.terminal.writeln(`\r
[Shell stopped]`),i.dispose(),i=null),v=null,f.disabled=!1,w.disabled=!0}f.addEventListener("click",ae);w.addEventListener("click",ie);y.addEventListener("change",()=>{const e={hello:"echo hello",ls:"ls /tmp",pipe:'echo "hello world" | wc -c',loop:"i=1; while [ $i -le 5 ]; do echo $i; i=$((i+1)); done",files:"echo test > /tmp/f.txt && cat /tmp/f.txt"},n=y.value;n&&e[n]&&i&&i.write(e[n]+`
`),y.value=""});const U=new TextDecoder,W={hello:`echo "Hello from dash on WebAssembly!"
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
`};function c(e,n){const s=document.createElement("span");n&&(s.className=n),s.textContent=e,u.appendChild(s),u.scrollTop=u.scrollHeight}async function P(){x.disabled=!0,u.textContent="";try{const e=await M();e&&c(e,"info");const n=B.value;d("Running shell...","running");const s=new S({onStdout:a=>c(U.decode(a)),onStderr:a=>c(U.decode(a),"stderr")});await s.init(m),H(s);const o=await s.spawn(r,["dash"],{env:["HOME=/home","TMPDIR=/tmp","TERM=dumb","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],stdin:se.encode(n)});c(`
Exited with code ${o}
`,"info"),A()}catch(e){c(`
Error: ${e}
`,"stderr"),d(`Error: ${e}`,"error"),console.error(e)}finally{x.disabled=!1}}x.addEventListener("click",P);g.addEventListener("change",()=>{const e=g.value;e&&W[e]&&(B.value=W[e]),g.value=""});B.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),P())});
