import{k as $,B as D}from"./browser-kernel-CeVfDkIW.js";/* empty css               */import{P as H}from"./xterm-CyPUMFhC.js";const h="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";function K(e){const n=e.endsWith("==")?2:e.endsWith("=")?1:0,t=new Uint8Array(e.length*3/4-n);let i=0;for(let r=0;r<e.length;r+=4){const l=h.indexOf(e[r]),u=h.indexOf(e[r+1]),d=h.indexOf(e[r+2]),s=h.indexOf(e[r+3]),o=l<<18|u<<12|Math.max(0,d)<<6|Math.max(0,s);t[i++]=o>>16&255,i<t.length&&(t[i++]=o>>8&255),i<t.length&&(t[i++]=o&255)}return t}async function F(e,n,t){const i=await fetch(n);if(!i.ok)throw new Error(`Failed to load Python stdlib bundle from ${n} (${i.status}). Run: bash examples/browser/scripts/build-python-bundle.sh`);const r=await i.json(),l=new Set;function u(s){if(l.has(s)||s==="/"||s==="")return;const o=s.substring(0,s.lastIndexOf("/"))||"/";if(u(o),!l.has(s)){try{e.mkdir(s,493)}catch{}l.add(s)}}let d=0;for(const s of r.files){const o=s.path.substring(0,s.path.lastIndexOf("/"));u(o);const f=K(s.data),P=e.open(s.path,66,420);e.write(P,f,0,f.length),e.close(P),d++,t&&d%50===0&&t(d,r.files.length)}return t&&t(d,r.files.length),d}const U="/wasm-posix-kernel/assets/python-BtBWr3yA.wasm",C=document.getElementById("terminal"),w=document.getElementById("start"),E=document.getElementById("stop"),x=document.getElementById("snippets"),O=document.getElementById("code"),y=document.getElementById("batch-output"),B=document.getElementById("run"),v=document.getElementById("examples"),b=document.getElementById("status"),_=document.getElementById("mode-interactive"),L=document.getElementById("mode-batch"),S=document.getElementById("interactive-view"),R=document.getElementById("batch-view"),T=new TextDecoder,Y=new TextEncoder;_.addEventListener("click",()=>{_.classList.add("active"),L.classList.remove("active"),S.classList.remove("hidden"),R.classList.add("hidden")});L.addEventListener("click",()=>{L.classList.add("active"),_.classList.remove("active"),R.classList.remove("hidden"),S.classList.add("hidden")});function c(e,n){b.style.display="block",b.textContent=e,b.className=`status ${n}`}function W(){b.style.display="none"}let g=null,p=null;async function A(){if(g&&p)return"";c("Loading kernel + CPython (~25MB)...","loading");const e=await Promise.all([fetch($).then(n=>n.arrayBuffer()),fetch(U).then(n=>n.arrayBuffer())]);return g=e[0],p=e[1],[`Kernel: ${(g.byteLength/1024).toFixed(0)}KB`,`CPython: ${(p.byteLength/(1024*1024)).toFixed(1)}MB`].join(", ")+`
`}async function M(e){const n=new D({onStdout:e==null?void 0:e.onStdout,onStderr:e==null?void 0:e.onStderr});await n.init(g);const t=n.fs;for(const r of["/usr","/usr/lib","/usr/lib/python3.13","/tmp","/home"])try{t.mkdir(r,493)}catch{}c("Loading Python stdlib...","loading");const i=await F(t,"/wasm-posix-kernel/python-bundle.json",(r,l)=>{c(`Loading Python stdlib... ${r}/${l} files`,"loading")});return c(`Stdlib loaded (${i} files). Starting Python...`,"loading"),n}const N=["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","LANG=en_US.UTF-8","PATH=/usr/local/bin:/usr/bin:/bin","PYTHONHOME=/usr","PYTHONDONTWRITEBYTECODE=1"];let k=null,a=null;async function q(){w.disabled=!0,E.disabled=!1,C.innerHTML="";try{const e=await A(),n=await M();k=n;const t=new H(C,n);a=t,e&&t.terminal.writeln(e.trimEnd()),c("Starting Python REPL...","running"),W(),t.terminal.focus();const i=await t.spawn(p,["python3","-i"],{env:N});t.terminal.writeln(`\r
[Python exited with code ${i}]`)}catch(e){a&&a.terminal.writeln(`\r
Error: ${e}`),c(`Error: ${e}`,"error"),console.error(e)}finally{k=null,w.disabled=!1,E.disabled=!0}}function G(){a&&(a.terminal.writeln(`\r
[Python stopped]`),a.dispose(),a=null),k=null,w.disabled=!1,E.disabled=!0}w.addEventListener("click",q);E.addEventListener("click",G);x.addEventListener("change",()=>{const e={hello:'print("Hello, World!")',math:'import math; print(f"pi = {math.pi}")',list:"[x**2 for x in range(10)]",dict:'d = {"a": 1, "b": 2}; print(d)',sys:"import sys; print(sys.version)"},n=x.value;n&&e[n]&&a&&a.write(e[n]+`
`),x.value=""});const I={hello:`print("Hello from CPython 3.13.3 on WebAssembly!")

import sys
print(f"Python {sys.version}")
print(f"Platform: {sys.platform}")
print(f"Byte order: {sys.byteorder}")
print(f"Max int: {sys.maxsize}")
`,fib:`def fibonacci(n):
    """Generate first n Fibonacci numbers."""
    a, b = 0, 1
    result = []
    for _ in range(n):
        result.append(a)
        a, b = b, a + b
    return result

for i, f in enumerate(fibonacci(20)):
    print(f"F({i:2d}) = {f}")
`,json:`import json

data = {
    "name": "wasm-posix-kernel",
    "language": "Python",
    "version": "3.13.3",
    "features": ["REPL", "stdlib", "json", "math", "collections"],
    "nested": {
        "runs_in": "WebAssembly",
        "kernel": "POSIX-compliant",
    },
}

formatted = json.dumps(data, indent=2)
print(formatted)

# Round-trip test
parsed = json.loads(formatted)
assert parsed == data
print("\\nJSON round-trip: OK")
`,collections:`from collections import Counter, defaultdict, namedtuple

# Counter
words = "the quick brown fox jumps over the lazy dog the fox".split()
counts = Counter(words)
print("Word counts:")
for word, count in counts.most_common(5):
    print(f"  {word}: {count}")

# defaultdict
graph = defaultdict(list)
edges = [(1, 2), (1, 3), (2, 4), (3, 4), (4, 5)]
for a, b in edges:
    graph[a].append(b)
    graph[b].append(a)
print("\\nAdjacency list:")
for node in sorted(graph):
    print(f"  {node}: {graph[node]}")

# namedtuple
Point = namedtuple("Point", ["x", "y"])
p = Point(3, 4)
print(f"\\nPoint: {p}, distance from origin: {(p.x**2 + p.y**2)**0.5:.2f}")
`,classes:`class Animal:
    def __init__(self, name, sound):
        self.name = name
        self.sound = sound

    def speak(self):
        return f"{self.name} says {self.sound}!"

    def __repr__(self):
        return f"Animal({self.name!r}, {self.sound!r})"

class Dog(Animal):
    def __init__(self, name):
        super().__init__(name, "Woof")

    def fetch(self, item):
        return f"{self.name} fetches the {item}!"

class Cat(Animal):
    def __init__(self, name):
        super().__init__(name, "Meow")

    def purr(self):
        return f"{self.name} purrs..."

pets = [Dog("Rex"), Cat("Whiskers"), Dog("Buddy"), Cat("Luna")]
for pet in pets:
    print(pet.speak())

print()
print(f"{pets[0].fetch('ball')}")
print(f"{pets[1].purr()}")
`,functional:`from functools import reduce
import math

# Map, filter, reduce
numbers = list(range(1, 11))
print(f"Numbers: {numbers}")

squares = list(map(lambda x: x**2, numbers))
print(f"Squares: {squares}")

evens = list(filter(lambda x: x % 2 == 0, numbers))
print(f"Evens: {evens}")

total = reduce(lambda a, b: a + b, numbers)
print(f"Sum: {total}")

product = reduce(lambda a, b: a * b, numbers)
print(f"Product: {product}")

# Comprehensions
matrix = [[i * j for j in range(1, 6)] for i in range(1, 6)]
print("\\nMultiplication table:")
for row in matrix:
    print("  " + "  ".join(f"{x:3d}" for x in row))

# Generator expression
primes = [n for n in range(2, 50) if all(n % i != 0 for i in range(2, int(math.sqrt(n)) + 1))]
print(f"\\nPrimes under 50: {primes}")
`};function m(e,n){const t=document.createElement("span");n&&(t.className=n),t.textContent=e,y.appendChild(t),y.scrollTop=y.scrollHeight}async function j(){B.disabled=!0,y.textContent="";try{const e=await A();e&&m(e,"info");const n=O.value,t=await M({onStdout:f=>m(T.decode(f)),onStderr:f=>m(T.decode(f),"stderr")}),i="/tmp/script.py",r=Y.encode(n),s=t.fs.open(i,1|64|512,420);t.fs.write(s,r,null,r.length),t.fs.close(s),c("Running Python...","running");const o=await t.spawn(p,["python3",i],{env:N});m(`
Exited with code ${o}
`,"info"),W()}catch(e){m(`
Error: ${e}
`,"stderr"),c(`Error: ${e}`,"error"),console.error(e)}finally{B.disabled=!1}}B.addEventListener("click",j);v.addEventListener("change",()=>{const e=v.value;e&&I[e]&&(O.value=I[e]),v.value=""});O.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),j())});
