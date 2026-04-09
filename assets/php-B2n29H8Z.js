import{B as _,k as g}from"./browser-kernel-DKpCrzg4.js";/* empty css               */const S="/wasm-posix-kernel/assets/php-CUZZnCmB.wasm",m=document.getElementById("code"),r=document.getElementById("output"),u=document.getElementById("run"),l=document.getElementById("examples"),o=document.getElementById("status"),f=new TextDecoder,T=new TextEncoder;function s(e,n){const t=document.createElement("span");n&&(t.className=n),t.textContent=e,r.appendChild(t),r.scrollTop=r.scrollHeight}function d(e,n){o.style.display="block",o.textContent=e,o.className=`status ${n}`}function w(){o.style.display="none"}const E={hello:`<?php
echo "Hello from PHP on WebAssembly!\\n";
echo "PHP version: " . PHP_VERSION . "\\n";
echo "OS: " . PHP_OS . "\\n";
`,fibonacci:`<?php
function fibonacci(int $n): int {
    if ($n <= 1) return $n;
    return fibonacci($n - 1) + fibonacci($n - 2);
}

echo "Fibonacci sequence:\\n";
for ($i = 0; $i < 20; $i++) {
    echo "  fib($i) = " . fibonacci($i) . "\\n";
}
`,sqlite:`<?php
$db = new SQLite3(":memory:");
$db->exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");
$db->exec("INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')");
$db->exec("INSERT INTO users VALUES (2, 'Bob', 'bob@example.com')");
$db->exec("INSERT INTO users VALUES (3, 'Charlie', 'charlie@example.com')");

$result = $db->query("SELECT * FROM users ORDER BY name");
echo "Users table:\\n";
echo str_pad("ID", 4) . str_pad("Name", 12) . "Email\\n";
echo str_repeat("-", 40) . "\\n";
while ($row = $result->fetchArray(SQLITE3_ASSOC)) {
    echo str_pad($row['id'], 4) . str_pad($row['name'], 12) . $row['email'] . "\\n";
}

echo "\\nTotal: " . $db->querySingle("SELECT COUNT(*) FROM users") . " users\\n";
`,json:`<?php
$data = [
    "name" => "wasm-posix-kernel",
    "language" => "PHP " . PHP_VERSION,
    "platform" => PHP_OS,
    "features" => ["SQLite3", "JSON", "mbstring", "XML", "sessions"],
    "running_in" => "WebAssembly",
];

echo "JSON encode:\\n";
echo json_encode($data, JSON_PRETTY_PRINT) . "\\n\\n";

$json = '{"temperatures":[72.5,68.3,75.1,80.2,65.8]}';
$parsed = json_decode($json, true);
$avg = array_sum($parsed['temperatures']) / count($parsed['temperatures']);
echo "JSON decode + processing:\\n";
echo "  Average temperature: " . number_format($avg, 1) . "\\n";
`,classes:`<?php
class Animal {
    public function __construct(
        protected string $name,
        protected string $sound,
    ) {}

    public function speak(): string {
        return "$this->name says $this->sound!";
    }
}

class Dog extends Animal {
    public function __construct(string $name) {
        parent::__construct($name, "Woof");
    }

    public function fetch(string $item): string {
        return "$this->name fetches the $item!";
    }
}

$animals = [
    new Animal("Cat", "Meow"),
    new Dog("Rex"),
    new Animal("Cow", "Moo"),
];

foreach ($animals as $animal) {
    echo $animal->speak() . "\\n";
    if ($animal instanceof Dog) {
        echo $animal->fetch("ball") . "\\n";
    }
}
`,arrays:`<?php
$numbers = range(1, 20);

echo "Original: " . implode(", ", $numbers) . "\\n\\n";

$evens = array_filter($numbers, fn($n) => $n % 2 === 0);
echo "Evens: " . implode(", ", $evens) . "\\n";

$squares = array_map(fn($n) => $n * $n, $numbers);
echo "Squares: " . implode(", ", array_slice($squares, 0, 10)) . "...\\n";

$sum = array_reduce($numbers, fn($carry, $n) => $carry + $n, 0);
echo "Sum: $sum\\n";

$fruits = ["banana", "apple", "cherry", "date", "elderberry"];
sort($fruits);
echo "\\nSorted fruits: " . implode(", ", $fruits) . "\\n";

$counts = array_count_values(str_split("hello world"));
arsort($counts);
echo "\\nCharacter frequency in 'hello world':\\n";
foreach ($counts as $char => $count) {
    $display = $char === " " ? "(space)" : $char;
    echo "  $display: $count\\n";
}
`};let a=null,c=null;async function P(){a&&c||(d("Loading kernel and PHP wasm...","loading"),[a,c]=await Promise.all([fetch(g).then(e=>e.arrayBuffer()),fetch(S).then(e=>e.arrayBuffer())]),s(`Kernel: ${(a.byteLength/1024).toFixed(0)}KB, PHP: ${(c.byteLength/(1024*1024)).toFixed(1)}MB
`,"info"))}async function y(){u.disabled=!0,r.textContent="";try{await P();const e=m.value;d("Running PHP...","running");const n=new _({onStdout:i=>s(f.decode(i)),onStderr:i=>s(f.decode(i),"stderr")});await n.init(a);const t=n.fs,p=T.encode(e),$="/tmp/script.php",h=t.open($,1|64|512,420);t.write(h,p,null,p.length),t.close(h);const b=await n.spawn(c,["php",$],{env:["HOME=/home","TMPDIR=/tmp","TERM=xterm-256color","PATH=/usr/local/bin:/usr/bin:/bin"]});s(`
Exited with code ${b}
`,"info"),w()}catch(e){s(`
Error: ${e}
`,"stderr"),d(`Error: ${e}`,"error"),console.error(e)}finally{u.disabled=!1}}u.addEventListener("click",y);l.addEventListener("change",()=>{const e=l.value;e&&E[e]&&(m.value=E[e]),l.value=""});m.addEventListener("keydown",e=>{(e.ctrlKey||e.metaKey)&&e.key==="Enter"&&(e.preventDefault(),y())});
