import{B as I,k as R}from"./browser-kernel-BnKUUWNh.js";/* empty css               */import{P as D}from"./xterm-CyPUMFhC.js";import{d as z,c as q,g as O,s as j}from"./sed-C3GaF0T-.js";const K="/wasm-posix-kernel/assets/bc-KVYwR7Zy.wasm",N="/wasm-posix-kernel/assets/file-_be0UJNS.wasm",V="/wasm-posix-kernel/assets/magic-COfg-bwM.lite",_="/wasm-posix-kernel/assets/less-BeqAJbnZ.wasm",G="/wasm-posix-kernel/assets/m4-dIOGglme.wasm",J="/wasm-posix-kernel/assets/make-Cxi4PLe4.wasm",Y="/wasm-posix-kernel/assets/tar-DMBxRNk3.wasm",Z="/wasm-posix-kernel/assets/curl-ChylmRUE.wasm",X="/wasm-posix-kernel/assets/wget-Bhamrlkv.wasm",Q="/wasm-posix-kernel/assets/git-DBunwiaM.wasm",C=document.getElementById("terminal"),y=document.getElementById("start"),w=document.getElementById("stop"),g=document.getElementById("snippets"),L=document.getElementById("code"),f=document.getElementById("batch-output"),x=document.getElementById("run"),k=document.getElementById("examples"),b=document.getElementById("status"),$=document.getElementById("mode-interactive"),v=document.getElementById("mode-batch"),W=document.getElementById("interactive-view"),A=document.getElementById("batch-view"),ee=new TextEncoder;$.addEventListener("click",()=>{$.classList.add("active"),v.classList.remove("active"),W.classList.remove("hidden"),A.classList.add("hidden")});v.addEventListener("click",()=>{v.classList.add("active"),$.classList.remove("active"),A.classList.remove("hidden"),W.classList.add("hidden")});function d(e,t){b.style.display="block",b.textContent=e,b.className=`status ${t}`}function H(){b.style.display="none"}const te=["arch","b2sum","base32","base64","basename","basenc","cat","chcon","chgrp","chmod","chown","chroot","cksum","comm","cp","csplit","cut","date","dd","df","dir","dircolors","dirname","du","echo","env","expand","expr","factor","false","fmt","fold","groups","head","hostid","id","install","join","link","ln","logname","ls","md5sum","mkdir","mkfifo","mknod","mktemp","mv","nice","nl","nohup","nproc","numfmt","od","paste","pathchk","pr","printenv","printf","ptx","pwd","readlink","realpath","rm","rmdir","runcon","seq","sha1sum","sha224sum","sha256sum","sha384sum","sha512sum","shred","shuf","sleep","sort","split","stat","stty","sum","sync","tac","tail","tee","test","timeout","touch","tr","true","truncate","tsort","tty","uname","unexpand","uniq","unlink","vdir","wc","whoami","yes"];let m=null,r=null,c=[],E=[];async function ne(e){try{const t=await fetch(e,{method:"HEAD"});return t.ok&&parseInt(t.headers.get("content-length")||"0",10)||0}catch{return 0}}async function M(){if(m&&r)return"";d("Loading kernel and dash...","loading");const[e,t]=await Promise.all([fetch(R).then(n=>n.arrayBuffer()),fetch(z).then(n=>n.arrayBuffer())]);m=e,r=t;const s=[{url:q,path:"/bin/coreutils",symlinks:[...te,"["].flatMap(n=>[`/bin/${n}`,`/usr/bin/${n}`])},{url:O,path:"/usr/bin/grep",symlinks:["/bin/grep","/usr/bin/egrep","/bin/egrep","/usr/bin/fgrep","/bin/fgrep"]},{url:j,path:"/usr/bin/sed",symlinks:["/bin/sed"]},{url:K,path:"/usr/bin/bc",symlinks:["/bin/bc"]},{url:N,path:"/usr/bin/file",symlinks:["/bin/file"]},{url:_,path:"/usr/bin/less",symlinks:["/bin/less"]},{url:G,path:"/usr/bin/m4",symlinks:["/bin/m4"]},{url:J,path:"/usr/bin/make",symlinks:["/bin/make"]},{url:Y,path:"/usr/bin/tar",symlinks:["/bin/tar"]},{url:Z,path:"/usr/bin/curl",symlinks:["/bin/curl"]},{url:X,path:"/usr/bin/wget",symlinks:["/bin/wget"]},{url:Q,path:"/usr/bin/git",symlinks:["/bin/git"]}],o=[{url:V,path:"/usr/share/misc/magic"}],[i,...a]=await Promise.all([Promise.all(s.map(n=>ne(n.url))),...o.map(async n=>{try{const p=await fetch(n.url);return p.ok?await p.arrayBuffer():null}catch{return null}})]);c=[];for(let n=0;n<s.length;n++)i[n]>0&&c.push({...s[n],size:i[n]});E=[];for(let n=0;n<o.length;n++)a[n]&&E.push({...o[n],data:a[n]});const u=[`Kernel: ${(m.byteLength/1024).toFixed(0)}KB`,`dash: ${(r.byteLength/1024).toFixed(0)}KB`];for(const n of c){const p=n.path.split("/").pop();u.push(`${p}: ${(n.size/(1024*1024)).toFixed(1)}MB (lazy)`)}return u.join(", ")+`
`}function U(e,t,s){const o=new Uint8Array(s),i=e.open(t,577,493);e.write(i,o,null,o.length),e.close(i)}function P(e){const t=e.fs;for(const a of["/bin","/usr","/usr/bin","/usr/local","/usr/local/bin","/usr/share","/usr/share/misc","/usr/share/file","/etc","/root"])try{t.mkdir(a,493)}catch{}const s=["[maintenance]","	auto = false","[gc]","	auto = 0","[core]","	pager = cat","[user]","	name = User","	email = user@wasm.local","[init]","	defaultBranch = main",""].join(`
`),o=new TextEncoder().encode(s),i=t.open("/etc/gitconfig",577,420);if(t.write(i,o,null,o.length),t.close(i),r){U(t,"/bin/dash",r);try{t.symlink("/bin/dash","/bin/sh")}catch{}try{t.symlink("/bin/dash","/usr/bin/dash")}catch{}try{t.symlink("/bin/dash","/usr/bin/sh")}catch{}}if(c.length>0){e.registerLazyFiles(c.map(a=>({path:a.path,url:a.url,size:a.size,mode:493})));for(const a of c)for(const u of a.symlinks)try{t.symlink(a.path,u)}catch{}}for(const a of E)a.data&&U(t,a.path,a.data)}let B=null,l=null;async function se(){y.disabled=!0,w.disabled=!1,C.innerHTML="";try{const e=await M();d("Starting shell...","running");const t=new I;await t.init(m),P(t),B=t;const s=new D(C,t);l=s,e&&s.terminal.writeln(e.trimEnd()),H(),s.terminal.focus();const o=await s.spawn(r,["dash","-i"],{env:["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin","PS1=$ "]});s.terminal.writeln(`\r
[Shell exited with code ${o}]`)}catch(e){l&&l.terminal.writeln(`\r
Error: ${e}`),d(`Error: ${e}`,"error"),console.error(e)}finally{B=null,y.disabled=!1,w.disabled=!0}}function ae(){l&&(l.terminal.writeln(`\r
[Shell stopped]`),l.dispose(),l=null),B=null,y.disabled=!1,w.disabled=!0}y.addEventListener("click",se);w.addEventListener("click",ae);g.addEventListener("change",()=>{const e={hello:"echo hello",ls:"ls /tmp",pipe:'echo "hello world" | wc -c',loop:"i=1; while [ $i -le 5 ]; do echo $i; i=$((i+1)); done",files:"echo test > /tmp/f.txt && cat /tmp/f.txt"},t=g.value;t&&e[t]&&l&&l.write(e[t]+`
`),g.value=""});const T=new TextDecoder,S={hello:`echo "Hello from dash on WebAssembly!"
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
`};function h(e,t){const s=document.createElement("span");t&&(s.className=t),s.textContent=e,f.appendChild(s),f.scrollTop=f.scrollHeight}async function F(){x.disabled=!0,f.textContent="";try{const e=await M();e&&h(e,"info");const t=L.value;d("Running shell...","running");const s=new I({onStdout:i=>h(T.decode(i)),onStderr:i=>h(T.decode(i),"stderr")});await s.init(m),P(s);const o=await s.spawn(r,["dash"],{env:["HOME=/home","TMPDIR=/tmp","TERM=dumb","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],stdin:ee.encode(t)});h(`
Exited with code ${o}
`,"info"),H()}catch(e){h(`
Error: ${e}
`,"stderr"),d(`Error: ${e}`,"error"),console.error(e)}finally{x.disabled=!1}}x.addEventListener("click",F);k.addEventListener("change",()=>{const e=k.value;e&&S[e]&&(L.value=S[e]),k.value=""});L.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),F())});
