import{B as I,k as R}from"./browser-kernel-CJ1uzMhJ.js";/* empty css               */import{P as D}from"./xterm-CyPUMFhC.js";import{d as z,c as q,g as O,s as j}from"./sed-DBgf8QW4.js";const K="/wasm-posix-kernel/assets/bc-KVYwR7Zy.wasm",N="/wasm-posix-kernel/assets/file-_be0UJNS.wasm",V="/wasm-posix-kernel/assets/magic-COfg-bwM.lite",_="/wasm-posix-kernel/assets/less-BeqAJbnZ.wasm",G="/wasm-posix-kernel/assets/m4-dIOGglme.wasm",J="/wasm-posix-kernel/assets/make-Cxi4PLe4.wasm",Y="/wasm-posix-kernel/assets/tar-DMBxRNk3.wasm",Z="/wasm-posix-kernel/assets/curl-ChylmRUE.wasm",X="/wasm-posix-kernel/assets/wget-Bhamrlkv.wasm",C=document.getElementById("terminal"),b=document.getElementById("start"),f=document.getElementById("stop"),y=document.getElementById("snippets"),E=document.getElementById("code"),u=document.getElementById("batch-output"),g=document.getElementById("run"),w=document.getElementById("examples"),p=document.getElementById("status"),k=document.getElementById("mode-interactive"),x=document.getElementById("mode-batch"),W=document.getElementById("interactive-view"),A=document.getElementById("batch-view"),Q=new TextEncoder;k.addEventListener("click",()=>{k.classList.add("active"),x.classList.remove("active"),W.classList.remove("hidden"),A.classList.add("hidden")});x.addEventListener("click",()=>{x.classList.add("active"),k.classList.remove("active"),A.classList.remove("hidden"),W.classList.add("hidden")});function d(e,n){p.style.display="block",p.textContent=e,p.className=`status ${n}`}function H(){p.style.display="none"}const ee=["arch","b2sum","base32","base64","basename","basenc","cat","chcon","chgrp","chmod","chown","chroot","cksum","comm","cp","csplit","cut","date","dd","df","dir","dircolors","dirname","du","echo","env","expand","expr","factor","false","fmt","fold","groups","head","hostid","id","install","join","link","ln","logname","ls","md5sum","mkdir","mkfifo","mknod","mktemp","mv","nice","nl","nohup","nproc","numfmt","od","paste","pathchk","pr","printenv","printf","ptx","pwd","readlink","realpath","rm","rmdir","runcon","seq","sha1sum","sha224sum","sha256sum","sha384sum","sha512sum","shred","shuf","sleep","sort","split","stat","stty","sum","sync","tac","tail","tee","test","timeout","touch","tr","true","truncate","tsort","tty","uname","unexpand","uniq","unlink","vdir","wc","whoami","yes"];let h=null,l=null,r=[],$=[];async function te(e){try{const n=await fetch(e,{method:"HEAD"});return n.ok&&parseInt(n.headers.get("content-length")||"0",10)||0}catch{return 0}}async function M(){if(h&&l)return"";d("Loading kernel and dash...","loading");const[e,n]=await Promise.all([fetch(R).then(s=>s.arrayBuffer()),fetch(z).then(s=>s.arrayBuffer())]);h=e,l=n;const t=[{url:q,path:"/bin/coreutils",symlinks:[...ee,"["].flatMap(s=>[`/bin/${s}`,`/usr/bin/${s}`])},{url:O,path:"/bin/grep",symlinks:["/bin/egrep","/bin/fgrep","/usr/bin/grep","/usr/bin/egrep","/usr/bin/fgrep"]},{url:j,path:"/bin/sed",symlinks:["/usr/bin/sed"]},{url:K,path:"/usr/bin/bc",symlinks:["/bin/bc"]},{url:N,path:"/usr/bin/file",symlinks:["/bin/file"]},{url:_,path:"/usr/bin/less",symlinks:["/bin/less"]},{url:G,path:"/usr/bin/m4",symlinks:["/bin/m4"]},{url:J,path:"/usr/bin/make",symlinks:["/bin/make"]},{url:Y,path:"/usr/bin/tar",symlinks:["/bin/tar"]},{url:Z,path:"/usr/bin/curl",symlinks:["/bin/curl"]},{url:X,path:"/usr/bin/wget",symlinks:["/bin/wget"]}],a=[{url:V,path:"/usr/share/misc/magic"}],[o,...B]=await Promise.all([Promise.all(t.map(s=>te(s.url))),...a.map(async s=>{try{const m=await fetch(s.url);return m.ok?await m.arrayBuffer():null}catch{return null}})]);r=[];for(let s=0;s<t.length;s++)o[s]>0&&r.push({...t[s],size:o[s]});$=[];for(let s=0;s<a.length;s++)B[s]&&$.push({...a[s],data:B[s]});const L=[`Kernel: ${(h.byteLength/1024).toFixed(0)}KB`,`dash: ${(l.byteLength/1024).toFixed(0)}KB`];for(const s of r){const m=s.path.split("/").pop();L.push(`${m}: ${(s.size/(1024*1024)).toFixed(1)}MB (lazy)`)}return L.join(", ")+`
`}function S(e,n,t){const a=new Uint8Array(t),o=e.open(n,577,493);e.write(o,a,null,a.length),e.close(o)}function P(e){const n=e.fs;for(const t of["/bin","/usr","/usr/bin","/usr/local","/usr/local/bin","/usr/share","/usr/share/misc","/usr/share/file"])try{n.mkdir(t,493)}catch{}if(l){S(n,"/bin/dash",l);try{n.symlink("/bin/dash","/bin/sh")}catch{}try{n.symlink("/bin/dash","/usr/bin/dash")}catch{}try{n.symlink("/bin/dash","/usr/bin/sh")}catch{}}if(r.length>0){e.registerLazyFiles(r.map(t=>({path:t.path,url:t.url,size:t.size,mode:493})));for(const t of r)for(const a of t.symlinks)try{n.symlink(t.path,a)}catch{}}for(const t of $)t.data&&S(n,t.path,t.data)}let v=null,i=null;async function ne(){b.disabled=!0,f.disabled=!1,C.innerHTML="";try{const e=await M();d("Starting shell...","running");const n=new I;await n.init(h),P(n),v=n;const t=new D(C,n);i=t,e&&t.terminal.writeln(e.trimEnd()),H(),t.terminal.focus();const a=await t.spawn(l,["dash","-i"],{env:["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin","PS1=$ "]});t.terminal.writeln(`\r
[Shell exited with code ${a}]`)}catch(e){i&&i.terminal.writeln(`\r
Error: ${e}`),d(`Error: ${e}`,"error"),console.error(e)}finally{v=null,b.disabled=!1,f.disabled=!0}}function se(){i&&(i.terminal.writeln(`\r
[Shell stopped]`),i.dispose(),i=null),v=null,b.disabled=!1,f.disabled=!0}b.addEventListener("click",ne);f.addEventListener("click",se);y.addEventListener("change",()=>{const e={hello:"echo hello",ls:"ls /tmp",pipe:'echo "hello world" | wc -c',loop:"i=1; while [ $i -le 5 ]; do echo $i; i=$((i+1)); done",files:"echo test > /tmp/f.txt && cat /tmp/f.txt"},n=y.value;n&&e[n]&&i&&i.write(e[n]+`
`),y.value=""});const T=new TextDecoder,U={hello:`echo "Hello from dash on WebAssembly!"
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
`};function c(e,n){const t=document.createElement("span");n&&(t.className=n),t.textContent=e,u.appendChild(t),u.scrollTop=u.scrollHeight}async function F(){g.disabled=!0,u.textContent="";try{const e=await M();e&&c(e,"info");const n=E.value;d("Running shell...","running");const t=new I({onStdout:o=>c(T.decode(o)),onStderr:o=>c(T.decode(o),"stderr")});await t.init(h),P(t);const a=await t.spawn(l,["dash"],{env:["HOME=/home","TMPDIR=/tmp","TERM=dumb","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin"],stdin:Q.encode(n)});c(`
Exited with code ${a}
`,"info"),H()}catch(e){c(`
Error: ${e}
`,"stderr"),d(`Error: ${e}`,"error"),console.error(e)}finally{g.disabled=!1}}g.addEventListener("click",F);w.addEventListener("change",()=>{const e=w.value;e&&U[e]&&(E.value=U[e]),w.value=""});E.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),F())});
