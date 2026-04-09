import{B as L,k as M}from"./browser-kernel-DKpCrzg4.js";/* empty css               */import{P as F}from"./xterm-CyPUMFhC.js";import{d as W,c as z,g as U,s as D}from"./sed-DBgf8QW4.js";const E=document.getElementById("terminal"),p=document.getElementById("start"),f=document.getElementById("stop"),b=document.getElementById("snippets"),x=document.getElementById("code"),m=document.getElementById("batch-output"),g=document.getElementById("run"),y=document.getElementById("examples"),u=document.getElementById("status"),$=document.getElementById("mode-interactive"),w=document.getElementById("mode-batch"),C=document.getElementById("interactive-view"),T=document.getElementById("batch-view"),R=new TextEncoder;$.addEventListener("click",()=>{$.classList.add("active"),w.classList.remove("active"),C.classList.remove("hidden"),T.classList.add("hidden")});w.addEventListener("click",()=>{w.classList.add("active"),$.classList.remove("active"),T.classList.remove("hidden"),C.classList.add("hidden")});function h(e,t){u.style.display="block",u.textContent=e,u.className=`status ${t}`}function S(){u.style.display="none"}const q=["arch","b2sum","base32","base64","basename","basenc","cat","chcon","chgrp","chmod","chown","chroot","cksum","comm","cp","csplit","cut","date","dd","df","dir","dircolors","dirname","du","echo","env","expand","expr","factor","false","fmt","fold","groups","head","hostid","id","install","join","link","ln","logname","ls","md5sum","mkdir","mkfifo","mknod","mktemp","mv","nice","nl","nohup","nproc","numfmt","od","paste","pathchk","pr","printenv","printf","ptx","pwd","readlink","realpath","rm","rmdir","runcon","seq","sha1sum","sha224sum","sha256sum","sha384sum","sha512sum","shred","shuf","sleep","sort","split","stat","stty","sum","sync","tac","tail","tee","test","timeout","touch","tr","true","truncate","tsort","tty","uname","unexpand","uniq","unlink","vdir","wc","whoami","yes"];let d=null,c=null,l=[];async function j(e){try{const t=await fetch(e,{method:"HEAD"});return t.ok&&parseInt(t.headers.get("content-length")||"0",10)||0}catch{return 0}}async function I(){if(d&&c)return"";h("Loading kernel and dash...","loading");const[e,t]=await Promise.all([fetch(M).then(o=>o.arrayBuffer()),fetch(W).then(o=>o.arrayBuffer())]);d=e,c=t;const n=[{url:z,path:"/bin/coreutils",symlinks:[...q,"["].flatMap(o=>[`/bin/${o}`,`/usr/bin/${o}`])},{url:U,path:"/bin/grep",symlinks:["/bin/egrep","/bin/fgrep","/usr/bin/grep","/usr/bin/egrep","/usr/bin/fgrep"]},{url:D,path:"/bin/sed",symlinks:["/usr/bin/sed"]}],i=await Promise.all(n.map(o=>j(o.url)));l=[];for(let o=0;o<n.length;o++)i[o]>0&&l.push({...n[o],size:i[o]});const s=[`Kernel: ${(d.byteLength/1024).toFixed(0)}KB`,`dash: ${(c.byteLength/1024).toFixed(0)}KB`];for(const o of l){const P=o.path.split("/").pop();s.push(`${P}: ${(o.size/(1024*1024)).toFixed(1)}MB (lazy)`)}return s.join(", ")+`
`}function O(e,t,n){const i=new Uint8Array(n),s=e.open(t,577,493);e.write(s,i,null,i.length),e.close(s)}function A(e){const t=e.fs;for(const n of["/bin","/usr","/usr/bin","/usr/local","/usr/local/bin"])try{t.mkdir(n,493)}catch{}if(c){O(t,"/bin/dash",c);try{t.symlink("/bin/dash","/bin/sh")}catch{}try{t.symlink("/bin/dash","/usr/bin/dash")}catch{}try{t.symlink("/bin/dash","/usr/bin/sh")}catch{}}if(l.length>0){e.registerLazyFiles(l.map(n=>({path:n.path,url:n.url,size:n.size,mode:493})));for(const n of l)for(const i of n.symlinks)try{t.symlink(n.path,i)}catch{}}}let v=null,a=null;async function K(){p.disabled=!0,f.disabled=!1,E.innerHTML="";try{const e=await I();h("Starting shell...","running");const t=new L;await t.init(d),A(t),v=t;const n=new F(E,t);a=n,e&&n.terminal.writeln(e.trimEnd()),S(),n.terminal.focus();const i=await n.spawn(c,["dash","-i"],{env:["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin","PS1=$ "]});n.terminal.writeln(`\r
[Shell exited with code ${i}]`)}catch(e){a&&a.terminal.writeln(`\r
Error: ${e}`),h(`Error: ${e}`,"error"),console.error(e)}finally{v=null,p.disabled=!1,f.disabled=!0}}function N(){a&&(a.terminal.writeln(`\r
[Shell stopped]`),a.dispose(),a=null),v=null,p.disabled=!1,f.disabled=!0}p.addEventListener("click",K);f.addEventListener("click",N);b.addEventListener("change",()=>{const e={hello:"echo hello",ls:"ls /tmp",pipe:'echo "hello world" | wc -c',loop:"i=1; while [ $i -le 5 ]; do echo $i; i=$((i+1)); done",files:"echo test > /tmp/f.txt && cat /tmp/f.txt"},t=b.value;t&&e[t]&&a&&a.write(e[t]+`
`),b.value=""});const k=new TextDecoder,B={hello:`echo "Hello from dash on WebAssembly!"
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
`};function r(e,t){const n=document.createElement("span");t&&(n.className=t),n.textContent=e,m.appendChild(n),m.scrollTop=m.scrollHeight}async function H(){g.disabled=!0,m.textContent="";try{const e=await I();e&&r(e,"info");const t=x.value;h("Running shell...","running");const n=new L({onStdout:s=>r(k.decode(s)),onStderr:s=>r(k.decode(s),"stderr")});await n.init(d),A(n);const i=await n.spawn(c,["dash"],{env:["HOME=/home","TMPDIR=/tmp","TERM=dumb","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],stdin:R.encode(t)});r(`
Exited with code ${i}
`,"info"),S()}catch(e){r(`
Error: ${e}
`,"stderr"),h(`Error: ${e}`,"error"),console.error(e)}finally{g.disabled=!1}}g.addEventListener("click",H);y.addEventListener("change",()=>{const e=y.value;e&&B[e]&&(x.value=B[e]),y.value=""});x.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),H())});
