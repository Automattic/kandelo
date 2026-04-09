/**
 * Shell browser demo — runs dash + GNU coreutils inside the POSIX kernel.
 * Two modes:
 *   - Interactive: xterm.js terminal with PTY-backed I/O (real terminal)
 *   - Batch (Script): textarea for entering a full script, click Run
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { PtyTerminal } from "../../lib/pty-terminal";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import dashWasmUrl from "../../../../examples/libs/dash/bin/dash.wasm?url";
import coreutilsWasmUrl from "../../../../examples/libs/coreutils/bin/coreutils.wasm?url";
import grepWasmUrl from "../../../../examples/libs/grep/bin/grep.wasm?url";
import sedWasmUrl from "../../../../examples/libs/sed/bin/sed.wasm?url";
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

// --- Coreutils command names for exec ---
const COREUTILS_NAMES = [
  "arch", "b2sum", "base32", "base64", "basename", "basenc", "cat",
  "chcon", "chgrp", "chmod", "chown", "chroot", "cksum", "comm", "cp",
  "csplit", "cut", "date", "dd", "df", "dir", "dircolors", "dirname",
  "du", "echo", "env", "expand", "expr", "factor", "false", "fmt",
  "fold", "groups", "head", "hostid", "id", "install", "join", "link",
  "ln", "logname", "ls", "md5sum", "mkdir", "mkfifo", "mknod", "mktemp",
  "mv", "nice", "nl", "nohup", "nproc", "numfmt", "od", "paste",
  "pathchk", "pr", "printenv", "printf", "ptx", "pwd", "readlink",
  "realpath", "rm", "rmdir", "runcon", "seq", "sha1sum", "sha224sum",
  "sha256sum", "sha384sum", "sha512sum", "shred", "shuf", "sleep",
  "sort", "split", "stat", "stty", "sum", "sync", "tac", "tail",
  "tee", "test", "timeout", "touch", "tr", "true", "truncate", "tsort",
  "tty", "uname", "unexpand", "uniq", "unlink", "vdir", "wc", "whoami",
  "yes",
];

// --- Binary loading ---
let kernelBytes: ArrayBuffer | null = null;
let dashBytes: ArrayBuffer | null = null;

/** Lazy-loaded utility binaries: fetched on demand when first exec'd. */
interface LazyBinary {
  url: string;
  path: string;
  size: number;
  symlinks: string[];
}
let lazyBinaries: LazyBinary[] = [];

/** Fetch file size via HEAD request. Returns 0 on failure. */
async function fetchSize(url: string): Promise<number> {
  try {
    const resp = await fetch(url, { method: "HEAD" });
    if (!resp.ok) return 0;
    return parseInt(resp.headers.get("content-length") || "0", 10) || 0;
  } catch {
    return 0;
  }
}

async function loadBinaries(): Promise<string> {
  if (kernelBytes && dashBytes) return "";

  setStatus("Loading kernel and dash...", "loading");

  // Eagerly fetch only the kernel and dash (required for startup)
  const [kernelResult, dashResult] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(dashWasmUrl).then((r) => r.arrayBuffer()),
  ]);
  kernelBytes = kernelResult;
  dashBytes = dashResult;

  // Fetch sizes for lazy-loaded utilities (HEAD requests, ~200 bytes each)
  const lazyDefs = [
    { url: coreutilsWasmUrl, path: "/bin/coreutils", symlinks: [...COREUTILS_NAMES, "["].flatMap(n => [`/bin/${n}`, `/usr/bin/${n}`]) },
    { url: grepWasmUrl, path: "/bin/grep", symlinks: ["/bin/egrep", "/bin/fgrep", "/usr/bin/grep", "/usr/bin/egrep", "/usr/bin/fgrep"] },
    { url: sedWasmUrl, path: "/bin/sed", symlinks: ["/usr/bin/sed"] },
  ];

  const sizes = await Promise.all(lazyDefs.map(d => fetchSize(d.url)));
  lazyBinaries = [];
  for (let i = 0; i < lazyDefs.length; i++) {
    if (sizes[i] > 0) {
      lazyBinaries.push({ ...lazyDefs[i], size: sizes[i] });
    }
  }

  const parts = [
    `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB`,
    `dash: ${(dashBytes.byteLength / 1024).toFixed(0)}KB`,
  ];
  for (const lb of lazyBinaries) {
    const name = lb.path.split("/").pop()!;
    parts.push(`${name}: ${(lb.size / (1024 * 1024)).toFixed(1)}MB (lazy)`);
  }
  return parts.join(", ") + "\n";
}

/**
 * Write a binary file to the virtual filesystem.
 */
function writeFileToFs(fs: import("../../lib/browser-kernel").BrowserKernel["fs"], path: string, data: ArrayBuffer): void {
  const bytes = new Uint8Array(data);
  const fd = fs.open(path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
  fs.write(fd, bytes, null, bytes.length);
  fs.close(fd);
}

/**
 * Populate the virtual filesystem with executable binaries.
 * Dash is written eagerly (required for shell startup).
 * Utilities (coreutils, grep, sed) are registered as lazy files
 * and fetched on demand when first exec'd.
 */
function populateExecBinaries(kernel: import("../../lib/browser-kernel").BrowserKernel): void {
  const fs = kernel.fs;
  for (const dir of ["/bin", "/usr", "/usr/bin", "/usr/local", "/usr/local/bin"]) {
    try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
  }

  // Write dash binary eagerly and create symlinks
  if (dashBytes) {
    writeFileToFs(fs, "/bin/dash", dashBytes);
    try { fs.symlink("/bin/dash", "/bin/sh"); } catch { /* exists */ }
    try { fs.symlink("/bin/dash", "/usr/bin/dash"); } catch { /* exists */ }
    try { fs.symlink("/bin/dash", "/usr/bin/sh"); } catch { /* exists */ }
  }

  // Register lazy binaries and create symlinks
  if (lazyBinaries.length > 0) {
    kernel.registerLazyFiles(lazyBinaries.map(lb => ({
      path: lb.path,
      url: lb.url,
      size: lb.size,
      mode: 0o755,
    })));
    for (const lb of lazyBinaries) {
      for (const link of lb.symlinks) {
        try { fs.symlink(lb.path, link); } catch { /* exists */ }
      }
    }
  }
}

// ============================================================
// Interactive mode
// ============================================================

let activeKernel: BrowserKernel | null = null;
let activePtyTerminal: PtyTerminal | null = null;

async function startInteractiveShell() {
  startBtn.disabled = true;
  stopBtn.disabled = false;

  // Clear the container for xterm.js
  terminalContainer.innerHTML = "";

  try {
    const info = await loadBinaries();

    setStatus("Starting shell...", "running");

    const kernel = new BrowserKernel();

    await kernel.init(kernelBytes!);
    populateExecBinaries(kernel);
    activeKernel = kernel;

    // Create PTY terminal
    const ptyTerminal = new PtyTerminal(terminalContainer, kernel);
    activePtyTerminal = ptyTerminal;

    if (info) {
      ptyTerminal.terminal.writeln(info.trimEnd());
    }

    hideStatus();
    ptyTerminal.terminal.focus();

    // Spawn dash in interactive mode with PTY
    const exitCode = await ptyTerminal.spawn(dashBytes!, ["dash", "-i"], {
      env: [
        "HOME=/home",
        "TMPDIR=/tmp",
        "TERM=xterm-256color",
        "LANG=en_US.UTF-8",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "PS1=$ ",
      ],
    });

    ptyTerminal.terminal.writeln(`\r\n[Shell exited with code ${exitCode}]`);
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

function stopInteractiveShell() {
  if (activePtyTerminal) {
    activePtyTerminal.terminal.writeln("\r\n[Shell stopped]");
    activePtyTerminal.dispose();
    activePtyTerminal = null;
  }
  activeKernel = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", startInteractiveShell);
stopBtn.addEventListener("click", stopInteractiveShell);

snippetsEl.addEventListener("change", () => {
  const snippets: Record<string, string> = {
    hello: "echo hello",
    ls: "ls /tmp",
    pipe: 'echo "hello world" | wc -c',
    loop: "i=1; while [ $i -le 5 ]; do echo $i; i=$((i+1)); done",
    files: "echo test > /tmp/f.txt && cat /tmp/f.txt",
  };
  const key = snippetsEl.value;
  if (key && snippets[key] && activePtyTerminal) {
    // Type the snippet text followed by Enter
    activePtyTerminal.write(snippets[key] + "\n");
  }
  snippetsEl.value = "";
});

// ============================================================
// Batch mode
// ============================================================

const decoder = new TextDecoder();

const EXAMPLES: Record<string, string> = {
  hello: `echo "Hello from dash on WebAssembly!"
echo "Shell: dash (Debian Almquist Shell)"
uname -a
echo "Current directory: $(pwd)"
echo "Home: $HOME"
echo "Path: $PATH"
`,
  pipes: `echo "Pipe examples:"
echo "---"

echo "Word frequency in a sentence:"
echo "the quick brown fox jumps over the lazy dog the fox" | tr ' ' '\\n' | sort | uniq -c | sort -rn

echo ""
echo "First 5 lines of sorted env:"
env | sort | head -5

echo ""
echo "Character count:"
echo "Hello, WebAssembly!" | wc -c
`,
  loops: `echo "Counting to 10:"
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
`,
  files: `echo "File operations in the virtual filesystem:"
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
`,
  text: `echo "Text processing with coreutils:"
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
`,
  subshell: `echo "Subshells and variables:"
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

    const commands = codeEl.value;
    setStatus("Running shell...", "running");

    const kernel = new BrowserKernel({
      onStdout: (data) => appendBatchOutput(decoder.decode(data)),
      onStderr: (data) => appendBatchOutput(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes!);
    populateExecBinaries(kernel);

    const exitCode = await kernel.spawn(dashBytes!, ["dash"], {
      env: [
        "HOME=/home",
        "TMPDIR=/tmp",
        "TERM=dumb",
        "LANG=en_US.UTF-8",
        "PATH=/usr/local/bin:/usr/bin:/bin",
      ],
      stdin: encoder.encode(commands),
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
