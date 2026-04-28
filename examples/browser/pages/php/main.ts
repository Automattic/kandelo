/**
 * PHP CLI browser demo — runs PHP inside the POSIX kernel,
 * with a textarea for entering code and output display.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import kernelWasmUrl from "@kernel-wasm?url";
import phpWasmUrl from "../../../../binaries/programs/wasm32/php/php.wasm?url";

const codeEl = document.getElementById("code") as HTMLTextAreaElement;
const output = document.getElementById("output") as HTMLPreElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const examplesEl = document.getElementById("examples") as HTMLSelectElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function appendOutput(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  output.appendChild(span);
  output.scrollTop = output.scrollHeight;
}

function setStatus(text: string, type: "loading" | "running" | "error") {
  statusDiv.style.display = "block";
  statusDiv.textContent = text;
  statusDiv.className = `status ${type}`;
}

function hideStatus() {
  statusDiv.style.display = "none";
}

// Example PHP programs
const EXAMPLES: Record<string, string> = {
  hello: `<?php
echo "Hello from PHP on WebAssembly!\\n";
echo "PHP version: " . PHP_VERSION . "\\n";
echo "OS: " . PHP_OS . "\\n";
`,
  fibonacci: `<?php
function fibonacci(int $n): int {
    if ($n <= 1) return $n;
    return fibonacci($n - 1) + fibonacci($n - 2);
}

echo "Fibonacci sequence:\\n";
for ($i = 0; $i < 20; $i++) {
    echo "  fib($i) = " . fibonacci($i) . "\\n";
}
`,
  sqlite: `<?php
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
`,
  json: `<?php
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
`,
  classes: `<?php
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
`,
  arrays: `<?php
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
`,
};

let kernelBytes: ArrayBuffer | null = null;
let phpBytes: ArrayBuffer | null = null;

async function loadBinaries() {
  if (kernelBytes && phpBytes) return;

  setStatus("Loading kernel and PHP wasm...", "loading");
  [kernelBytes, phpBytes] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(phpWasmUrl).then((r) => r.arrayBuffer()),
  ]);
  appendOutput(
    `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, PHP: ${(phpBytes.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
    "info",
  );
}

async function runPhp() {
  runBtn.disabled = true;
  output.textContent = "";

  try {
    await loadBinaries();

    const code = codeEl.value;
    setStatus("Running PHP...", "running");

    const kernel = new BrowserKernel({
      onStdout: (data) => appendOutput(decoder.decode(data)),
      onStderr: (data) => appendOutput(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes!);

    // Write PHP code to a file in the virtual filesystem
    const fs = kernel.fs;
    const scriptBytes = encoder.encode(code);
    const scriptPath = "/tmp/script.php";
    const O_WRONLY = 1;
    const O_CREAT = 0x40;
    const O_TRUNC = 0x200;
    const fd = fs.open(scriptPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    fs.write(fd, scriptBytes, null, scriptBytes.length);
    fs.close(fd);

    const exitCode = await kernel.spawn(phpBytes!, ["php", scriptPath], {
      env: [
        "HOME=/home",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ],
    });

    appendOutput(`\nExited with code ${exitCode}\n`, "info");
    hideStatus();
  } catch (e) {
    appendOutput(`\nError: ${e}\n`, "stderr");
    setStatus(`Error: ${e}`, "error");
    console.error(e);
  } finally {
    runBtn.disabled = false;
  }
}

// Wire up events
runBtn.addEventListener("click", runPhp);

examplesEl.addEventListener("change", () => {
  const key = examplesEl.value;
  if (key && EXAMPLES[key]) {
    codeEl.value = EXAMPLES[key];
  }
  examplesEl.value = ""; // Reset dropdown
});

// Ctrl+Enter to run
codeEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runPhp();
  }
});
