import{B as T,k as M}from"./browser-kernel-BPDGIj33.js";import{P as W}from"./xterm-CyPUMFhC.js";import{d as U,c as q,g as K,s as j}from"./sed-DBgf8QW4.js";const k=document.getElementById("terminal"),y=document.getElementById("start"),f=document.getElementById("stop"),g=document.getElementById("snippets"),B=document.getElementById("code"),p=document.getElementById("batch-output"),w=document.getElementById("run"),$=document.getElementById("examples"),b=document.getElementById("status"),x=document.getElementById("mode-interactive"),v=document.getElementById("mode-batch"),S=document.getElementById("interactive-view"),I=document.getElementById("batch-view"),D=new TextEncoder;x.addEventListener("click",()=>{x.classList.add("active"),v.classList.remove("active"),S.classList.remove("hidden"),I.classList.add("hidden")});v.addEventListener("click",()=>{v.classList.add("active"),x.classList.remove("active"),I.classList.remove("hidden"),S.classList.add("hidden")});function m(e,t){b.style.display="block",b.textContent=e,b.className=`status ${t}`}function A(){b.style.display="none"}const O=["arch","b2sum","base32","base64","basename","basenc","cat","chcon","chgrp","chmod","chown","chroot","cksum","comm","cp","csplit","cut","date","dd","df","dir","dircolors","dirname","du","echo","env","expand","expr","factor","false","fmt","fold","groups","head","hostid","id","install","join","link","ln","logname","ls","md5sum","mkdir","mkfifo","mknod","mktemp","mv","nice","nl","nohup","nproc","numfmt","od","paste","pathchk","pr","printenv","printf","ptx","pwd","readlink","realpath","rm","rmdir","runcon","seq","sha1sum","sha224sum","sha256sum","sha384sum","sha512sum","shred","shuf","sleep","sort","split","stat","stty","sum","sync","tac","tail","tee","test","timeout","touch","tr","true","truncate","tsort","tty","uname","unexpand","uniq","unlink","vdir","wc","whoami","yes"];let l=null,i=null,r=null,d=null,h=null;async function H(){if(l&&i)return"";m("Loading kernel, dash, coreutils, grep, sed...","loading");const e=await Promise.all([fetch(M).then(n=>n.arrayBuffer()),fetch(U).then(n=>n.arrayBuffer()),fetch(q).then(n=>n.arrayBuffer()).catch(()=>null),fetch(K).then(n=>n.arrayBuffer()).catch(()=>null),fetch(j).then(n=>n.arrayBuffer()).catch(()=>null)]);l=e[0],i=e[1],r=e[2],d=e[3],h=e[4];const t=[`Kernel: ${(l.byteLength/1024).toFixed(0)}KB`,`dash: ${(i.byteLength/1024).toFixed(0)}KB`];return r&&t.push(`coreutils: ${(r.byteLength/(1024*1024)).toFixed(1)}MB`),d&&t.push(`grep: ${(d.byteLength/1024).toFixed(0)}KB`),h&&t.push(`sed: ${(h.byteLength/1024).toFixed(0)}KB`),t.join(", ")+`
`}function u(e,t,n){const c=new Uint8Array(n),s=e.open(t,577,493);e.write(s,c,null,c.length),e.close(s)}function F(e){for(const t of["/bin","/usr","/usr/bin","/usr/local","/usr/local/bin"])try{e.mkdir(t,493)}catch{}if(i){u(e,"/bin/dash",i);try{e.symlink("/bin/dash","/bin/sh")}catch{}try{e.symlink("/bin/dash","/usr/bin/dash")}catch{}try{e.symlink("/bin/dash","/usr/bin/sh")}catch{}}if(r){u(e,"/bin/coreutils",r);for(const t of O){try{e.symlink("/bin/coreutils",`/bin/${t}`)}catch{}try{e.symlink("/bin/coreutils",`/usr/bin/${t}`)}catch{}}try{e.symlink("/bin/coreutils","/bin/[")}catch{}try{e.symlink("/bin/coreutils","/usr/bin/[")}catch{}}if(d){u(e,"/bin/grep",d);try{e.symlink("/bin/grep","/bin/egrep")}catch{}try{e.symlink("/bin/grep","/bin/fgrep")}catch{}try{e.symlink("/bin/grep","/usr/bin/grep")}catch{}try{e.symlink("/bin/grep","/usr/bin/egrep")}catch{}try{e.symlink("/bin/grep","/usr/bin/fgrep")}catch{}}if(h){u(e,"/bin/sed",h);try{e.symlink("/bin/sed","/usr/bin/sed")}catch{}}}let E=null,o=null;async function R(){y.disabled=!0,f.disabled=!1,k.innerHTML="";try{const e=await H();m("Starting shell...","running");const t=new T;await t.init(l),F(t.fs),E=t;const n=new W(k,t);o=n,e&&n.terminal.writeln(e.trimEnd()),A(),n.terminal.focus();const c=await n.spawn(i,["dash","-i"],{env:["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin","PS1=$ "]});n.terminal.writeln(`\r
[Shell exited with code ${c}]`)}catch(e){o&&o.terminal.writeln(`\r
Error: ${e}`),m(`Error: ${e}`,"error"),console.error(e)}finally{E=null,y.disabled=!1,f.disabled=!0}}function N(){o&&(o.terminal.writeln(`\r
[Shell stopped]`),o.dispose(),o=null),E=null,y.disabled=!1,f.disabled=!0}y.addEventListener("click",R);f.addEventListener("click",N);g.addEventListener("change",()=>{const e={hello:"echo hello",ls:"ls /tmp",pipe:'echo "hello world" | wc -c',loop:"i=1; while [ $i -le 5 ]; do echo $i; i=$((i+1)); done",files:"echo test > /tmp/f.txt && cat /tmp/f.txt"},t=g.value;t&&e[t]&&o&&o.write(e[t]+`
`),g.value=""});const L=new TextDecoder,C={hello:`echo "Hello from dash on WebAssembly!"
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
`};function a(e,t){const n=document.createElement("span");t&&(n.className=t),n.textContent=e,p.appendChild(n),p.scrollTop=p.scrollHeight}async function P(){w.disabled=!0,p.textContent="";try{const e=await H();e&&a(e,"info");const t=B.value;m("Running shell...","running");const n=new T({onStdout:s=>a(L.decode(s)),onStderr:s=>a(L.decode(s),"stderr")});await n.init(l),F(n.fs);const c=await n.spawn(i,["dash"],{env:["HOME=/home","TMPDIR=/tmp","TERM=dumb","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],stdin:D.encode(t)});a(`
Exited with code ${c}
`,"info"),A()}catch(e){a(`
Error: ${e}
`,"stderr"),m(`Error: ${e}`,"error"),console.error(e)}finally{w.disabled=!1}}w.addEventListener("click",P);$.addEventListener("change",()=>{const e=$.value;e&&C[e]&&(B.value=C[e]),$.value=""});B.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),P())});
