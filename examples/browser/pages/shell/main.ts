/**
 * Shell browser demo — runs dash + GNU coreutils inside the POSIX kernel.
 * Two modes:
 *   - Interactive: terminal-like UI with prompt, type commands one at a time
 *   - Batch (Script): textarea for entering a full script, click Run
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import dashWasmUrl from "../../../../examples/libs/dash/dash-src/src/dash?url";
import coreutilsWasmUrl from "../../../../examples/libs/coreutils/bin/coreutils.wasm?url";

// --- DOM elements ---
const terminalEl = document.getElementById("terminal") as HTMLDivElement;
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
let coreutilsBytes: ArrayBuffer | null = null;

async function loadBinaries(): Promise<string> {
  if (kernelBytes && dashBytes) return "";

  setStatus("Loading kernel, dash, and coreutils wasm...", "loading");
  const results = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(dashWasmUrl).then((r) => r.arrayBuffer()),
    fetch(coreutilsWasmUrl).then((r) => r.arrayBuffer()).catch(() => null),
  ]);
  kernelBytes = results[0];
  dashBytes = results[1];
  coreutilsBytes = results[2];

  const parts = [
    `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB`,
    `dash: ${(dashBytes.byteLength / 1024).toFixed(0)}KB`,
  ];
  if (coreutilsBytes) {
    parts.push(`coreutils: ${(coreutilsBytes.byteLength / (1024 * 1024)).toFixed(1)}MB`);
  }
  return parts.join(", ") + "\n";
}

// --- Exec path resolution ---
function resolveExecPath(path: string, _argv: string[], envp: string[]): ArrayBuffer | null {
  if (path.startsWith("/")) {
    if (path === "/bin/sh" || path === "/bin/dash") return dashBytes;
    if (coreutilsBytes) {
      const name = path.split("/").pop()!;
      if (COREUTILS_NAMES.includes(name) || name === "[") return coreutilsBytes;
    }
    return null;
  }

  const pathEnv = envp.find((e) => e.startsWith("PATH="))?.slice(5)
    ?? "/usr/local/bin:/usr/bin:/bin";
  for (const dir of pathEnv.split(":")) {
    const result = resolveExecPath(`${dir}/${path}`, _argv, envp);
    if (result) return result;
  }
  return null;
}

// ============================================================
// Interactive mode
// ============================================================

let activeKernel: BrowserKernel | null = null;
let activePid: number = 0;
// Buffer for current input line being typed
let inputBuffer = "";

function appendTerminal(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  terminalEl.appendChild(span);
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

async function startInteractiveShell() {
  startBtn.disabled = true;
  stopBtn.disabled = false;
  terminalEl.textContent = "";
  inputBuffer = "";

  try {
    const info = await loadBinaries();
    if (info) appendTerminal(info, "info");

    setStatus("Starting shell...", "running");

    const kernel = new BrowserKernel({
      onStdout: (data) => appendTerminal(decoder.decode(data)),
      onStderr: (data) => appendTerminal(decoder.decode(data), "stderr"),
      onExec: async (_pid, path, argv, envp) => {
        return resolveExecPath(path, argv, envp);
      },
    });

    await kernel.init(kernelBytes!);
    activeKernel = kernel;

    // Spawn dash in interactive mode (no stdin data = terminal mode)
    const pid = 1;
    activePid = pid;

    // Use spawn but don't await — it resolves when the process exits
    const exitPromise = kernel.spawn(dashBytes!, ["dash", "-i"], {
      env: [
        "HOME=/home",
        "TMPDIR=/tmp",
        "TERM=dumb",
        "LANG=en_US.UTF-8",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "PS1=$ ",
      ],
    });

    hideStatus();
    terminalEl.focus();

    // Wait for process exit
    const exitCode = await exitPromise;
    appendTerminal(`\n[Shell exited with code ${exitCode}]\n`, "info");
  } catch (e) {
    appendTerminal(`\nError: ${e}\n`, "stderr");
    setStatus(`Error: ${e}`, "error");
    console.error(e);
  } finally {
    activeKernel = null;
    activePid = 0;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

function stopInteractiveShell() {
  if (activeKernel && activePid) {
    // Send EOF (Ctrl+D) by closing stdin — send empty data
    // Actually, just stop the kernel by letting it gc
    activeKernel = null;
    activePid = 0;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    appendTerminal("\n[Shell stopped]\n", "info");
  }
}

// Handle keyboard input on terminal
terminalEl.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!activeKernel || !activePid) return;

  if (e.key === "Enter") {
    e.preventDefault();
    // Send current line + newline to stdin
    const line = inputBuffer + "\n";
    inputBuffer = "";
    (activeKernel.worker as any).appendStdinData(
      activePid,
      encoder.encode(line),
    );
  } else if (e.key === "Backspace") {
    e.preventDefault();
    if (inputBuffer.length > 0) {
      inputBuffer = inputBuffer.slice(0, -1);
      // Send backspace character to terminal (kernel echo will handle display)
      (activeKernel.worker as any).appendStdinData(
        activePid,
        new Uint8Array([0x7f]), // DEL character
      );
    }
  } else if (e.key === "c" && e.ctrlKey) {
    e.preventDefault();
    // Send SIGINT (Ctrl+C) — send ETX character
    inputBuffer = "";
    (activeKernel.worker as any).appendStdinData(
      activePid,
      new Uint8Array([0x03]),
    );
  } else if (e.key === "d" && e.ctrlKey) {
    e.preventDefault();
    // Send EOF (Ctrl+D) — send EOT character
    (activeKernel.worker as any).appendStdinData(
      activePid,
      new Uint8Array([0x04]),
    );
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    inputBuffer += e.key;
    // Send character to stdin (kernel echo will display it)
    (activeKernel.worker as any).appendStdinData(
      activePid,
      encoder.encode(e.key),
    );
  }
});

// Prevent tab from leaving terminal
terminalEl.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Tab") {
    e.preventDefault();
  }
});

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
  if (key && snippets[key] && activeKernel && activePid) {
    // Type the snippet into the terminal
    const text = snippets[key];
    inputBuffer += text;
    (activeKernel.worker as any).appendStdinData(
      activePid,
      encoder.encode(text),
    );
  }
  snippetsEl.value = "";
});

// ============================================================
// Batch mode
// ============================================================

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
      onExec: async (_pid, path, argv, envp) => {
        return resolveExecPath(path, argv, envp);
      },
    });

    await kernel.init(kernelBytes!);

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
