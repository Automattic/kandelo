/**
 * Python browser demo — CPython 3.13.3 running inside the POSIX kernel.
 * Two modes:
 *   - REPL: xterm.js terminal with PTY-backed I/O (real terminal)
 *   - Script: textarea for entering a full script, click Run
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { PtyTerminal } from "../../lib/pty-terminal";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { decompressVfsImage } from "../../../../host/src/vfs/load-image";
import kernelWasmUrl from "@kernel-wasm?url";
import pythonWasmUrl from "../../../../binaries/programs/wasm32/cpython.wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/python-vfs.vfs?url";
import "@xterm/xterm/css/xterm.css";

// --- DOM elements ---
const terminalContainer = document.getElementById("terminal") as HTMLDivElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const snippetsEl = document.getElementById("snippets") as HTMLSelectElement;
const codeEl = document.getElementById("code") as HTMLTextAreaElement;
const batchOutput = document.getElementById("batch-output") as HTMLPreElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const examplesEl = document.getElementById("examples") as HTMLSelectElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const modeInteractiveBtn = document.getElementById("mode-interactive") as HTMLButtonElement;
const modeBatchBtn = document.getElementById("mode-batch") as HTMLButtonElement;
const interactiveView = document.getElementById("interactive-view") as HTMLDivElement;
const batchView = document.getElementById("batch-view") as HTMLDivElement;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// --- Mode switching ---
let currentMode: "interactive" | "batch" = "interactive";

modeInteractiveBtn.addEventListener("click", () => {
  currentMode = "interactive";
  modeInteractiveBtn.classList.add("active");
  modeBatchBtn.classList.remove("active");
  interactiveView.classList.remove("hidden");
  batchView.classList.add("hidden");
});

modeBatchBtn.addEventListener("click", () => {
  currentMode = "batch";
  modeBatchBtn.classList.add("active");
  modeInteractiveBtn.classList.remove("active");
  batchView.classList.remove("hidden");
  interactiveView.classList.add("hidden");
});

// --- Status helpers ---
function setStatus(text: string, type: "loading" | "running" | "error") {
  statusDiv.style.display = "block";
  statusDiv.textContent = text;
  statusDiv.className = `status ${type}`;
}

function hideStatus() {
  statusDiv.style.display = "none";
}

// --- Binary loading ---
let kernelBytes: ArrayBuffer | null = null;
let pythonBytes: ArrayBuffer | null = null;
let vfsImageBuf: ArrayBuffer | null = null;

async function loadBinaries(): Promise<string> {
  if (kernelBytes && pythonBytes && vfsImageBuf) return "";

  setStatus("Loading kernel + CPython + stdlib (~25MB)...", "loading");
  const results = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(pythonWasmUrl).then((r) => r.arrayBuffer()),
    fetch(VFS_IMAGE_URL).then((r) => r.arrayBuffer()),
  ]);
  kernelBytes = results[0];
  pythonBytes = results[1];
  vfsImageBuf = results[2];

  return [
    `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB`,
    `CPython: ${(pythonBytes.byteLength / (1024 * 1024)).toFixed(1)}MB`,
    `Stdlib VFS: ${(vfsImageBuf.byteLength / (1024 * 1024)).toFixed(1)}MB`,
  ].join(", ") + "\n";
}

/** Initialize a kernel with the Python stdlib VFS image. */
async function initKernelWithStdlib(
  options?: { onStdout?: (data: Uint8Array) => void; onStderr?: (data: Uint8Array) => void },
): Promise<BrowserKernel> {
  const memfs = MemoryFileSystem.fromImage(decompressVfsImage(new Uint8Array(vfsImageBuf!)), {
    maxByteLength: 256 * 1024 * 1024,
  });
  const kernel = new BrowserKernel({
    memfs,
    onStdout: options?.onStdout,
    onStderr: options?.onStderr,
  });
  await kernel.init(kernelBytes!);

  return kernel;
}

const PYTHON_ENV = [
  "HOME=/home",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "PYTHONHOME=/usr",
  "PYTHONDONTWRITEBYTECODE=1",
];

// ============================================================
// Interactive REPL mode
// ============================================================

let activeKernel: BrowserKernel | null = null;
let activePtyTerminal: PtyTerminal | null = null;

async function startInteractiveRepl() {
  startBtn.disabled = true;
  stopBtn.disabled = false;

  // Clear the container for xterm.js
  terminalContainer.innerHTML = "";

  try {
    const info = await loadBinaries();

    const kernel = await initKernelWithStdlib();
    activeKernel = kernel;

    // Create PTY terminal
    const ptyTerminal = new PtyTerminal(terminalContainer, kernel);
    activePtyTerminal = ptyTerminal;

    if (info) {
      ptyTerminal.terminal.writeln(info.trimEnd());
    }

    setStatus("Starting Python REPL...", "running");
    hideStatus();
    ptyTerminal.terminal.focus();

    // Spawn python3 in interactive mode with PTY
    const exitCode = await ptyTerminal.spawn(pythonBytes!, ["python3", "-i"], {
      env: PYTHON_ENV,
    });

    ptyTerminal.terminal.writeln(`\r\n[Python exited with code ${exitCode}]`);
  } catch (e) {
    if (activePtyTerminal) {
      activePtyTerminal.terminal.writeln(`\r\nError: ${e}`);
    }
    setStatus(`Error: ${e}`, "error");
    console.error(e);
  } finally {
    activeKernel = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

function stopRepl() {
  if (activePtyTerminal) {
    activePtyTerminal.terminal.writeln("\r\n[Python stopped]");
    activePtyTerminal.dispose();
    activePtyTerminal = null;
  }
  activeKernel = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", startInteractiveRepl);
stopBtn.addEventListener("click", stopRepl);

snippetsEl.addEventListener("change", () => {
  const snippets: Record<string, string> = {
    hello: 'print("Hello, World!")',
    math: 'import math; print(f"pi = {math.pi}")',
    list: "[x**2 for x in range(10)]",
    dict: 'd = {"a": 1, "b": 2}; print(d)',
    sys: "import sys; print(sys.version)",
  };
  const key = snippetsEl.value;
  if (key && snippets[key] && activePtyTerminal) {
    activePtyTerminal.write(snippets[key] + "\n");
  }
  snippetsEl.value = "";
});

// ============================================================
// Script (batch) mode
// ============================================================

const EXAMPLES: Record<string, string> = {
  hello: `print("Hello from CPython 3.13.3 on WebAssembly!")

import sys
print(f"Python {sys.version}")
print(f"Platform: {sys.platform}")
print(f"Byte order: {sys.byteorder}")
print(f"Max int: {sys.maxsize}")
`,
  fib: `def fibonacci(n):
    """Generate first n Fibonacci numbers."""
    a, b = 0, 1
    result = []
    for _ in range(n):
        result.append(a)
        a, b = b, a + b
    return result

for i, f in enumerate(fibonacci(20)):
    print(f"F({i:2d}) = {f}")
`,
  json: `import json

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
`,
  collections: `from collections import Counter, defaultdict, namedtuple

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
`,
  classes: `class Animal:
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
`,
  functional: `from functools import reduce
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
`,
};

function appendBatchOutput(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  batchOutput.appendChild(span);
  batchOutput.scrollTop = batchOutput.scrollHeight;
}

async function runBatch() {
  runBtn.disabled = true;
  batchOutput.textContent = "";

  try {
    const info = await loadBinaries();
    if (info) appendBatchOutput(info, "info");

    const code = codeEl.value;

    const kernel = await initKernelWithStdlib({
      onStdout: (data) => appendBatchOutput(decoder.decode(data)),
      onStderr: (data) => appendBatchOutput(decoder.decode(data), "stderr"),
    });

    // Write script to a file in the VFS
    const scriptPath = "/tmp/script.py";
    const scriptBytes = encoder.encode(code);
    const O_WRONLY = 1;
    const O_CREAT = 0x40;
    const O_TRUNC = 0x200;
    const fd = kernel.fs.open(scriptPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
    kernel.fs.write(fd, scriptBytes, null, scriptBytes.length);
    kernel.fs.close(fd);

    setStatus("Running Python...", "running");

    const exitCode = await kernel.spawn(pythonBytes!, ["python3", scriptPath], {
      env: PYTHON_ENV,
    });

    appendBatchOutput(`\nExited with code ${exitCode}\n`, "info");
    hideStatus();
  } catch (e) {
    appendBatchOutput(`\nError: ${e}\n`, "stderr");
    setStatus(`Error: ${e}`, "error");
    console.error(e);
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", runBatch);

examplesEl.addEventListener("change", () => {
  const key = examplesEl.value;
  if (key && EXAMPLES[key]) {
    codeEl.value = EXAMPLES[key];
  }
  examplesEl.value = "";
});

codeEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runBatch();
  }
});
