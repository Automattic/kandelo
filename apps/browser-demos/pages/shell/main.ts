/**
 * Shell browser demo — runs dash + GNU coreutils inside the POSIX kernel.
 * Two modes:
 *   - Interactive: xterm.js terminal with PTY-backed I/O (real terminal)
 *   - Batch (Script): textarea for entering a full script, click Run
 *
 * The shell environment is pre-built into a VFS image (shell.vfs) containing
 * dash, symlinks, magic database, vim runtime, and system configs. At runtime
 * we restore the image, rewrite lazy asset URLs, and spawn bash.
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { PtyTerminal } from "../../lib/pty-terminal";
import {
  rewriteShellLazyFileUrls,
  shellLazyFileEntries,
} from "../../lib/init/shell-lazy-files";
import { resolveShellLazyArchiveUrl } from "../../lib/init/lazy-archives";
import kernelWasmUrl from "@kernel-wasm?url";
import bashWasmUrl from "@binaries/programs/wasm32/bash.wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/shell.vfs.zst?url";
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

let vfsImageBuf: ArrayBuffer | null = null;
let loadInfo = "";

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
let bashBytes: ArrayBuffer | null = null;

async function loadBinaries(): Promise<void> {
  if (kernelBytes && bashBytes && vfsImageBuf) return;

  setStatus("Loading kernel, shell, and VFS image...", "loading");

  // Eagerly fetch the kernel, bash (needed for spawning), and VFS image.
  // dash and utility metadata are baked into the image.
  const [kernelResult, bashResult, vfsResult] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(bashWasmUrl).then((r) => r.arrayBuffer()),
    fetch(VFS_IMAGE_URL).then((r) => {
      if (!r.ok) {
        throw new Error(
          `Failed to load VFS image from ${VFS_IMAGE_URL} (${r.status}). ` +
          `Run: bash images/vfs/scripts/build-shell-vfs-image.sh`
        );
      }
      return r.arrayBuffer();
    }),
  ]);
  kernelBytes = kernelResult;
  bashBytes = bashResult;
  vfsImageBuf = vfsResult;
  loadInfo = [
    `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB`,
    `bash: ${(bashBytes.byteLength / 1024).toFixed(0)}KB`,
    `VFS image: ${(vfsImageBuf.byteLength / (1024 * 1024)).toFixed(1)}MB`,
  ].join(", ");
}

function prepareShellFs(): MemoryFileSystem {
  const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsImageBuf!), {
    maxByteLength: 256 * 1024 * 1024,
  });
  prepareDemoFs(memfs);
  // URLs were stored as build-time placeholders; rewrite them to Vite asset
  // URLs before BrowserKernel.init forwards lazy metadata.
  memfs.rewriteLazyArchiveUrls(resolveShellLazyArchiveUrl);
  rewriteShellLazyFileUrls(memfs);
  return memfs;
}

function formatLazyInfo(memfs: MemoryFileSystem): string {
  const parts: string[] = [];
  for (const entry of shellLazyFileEntries(memfs)) {
    const name = entry.path.split("/").pop()!;
    parts.push(`${name}: ${(entry.size / (1024 * 1024)).toFixed(1)}MB (lazy)`);
  }
  return parts.length > 0 ? `${loadInfo}, ${parts.join(", ")}\n` : `${loadInfo}\n`;
}

// ============================================================
// Interactive mode
// ============================================================

let activeKernel: BrowserKernel | null = null;
let activePtyTerminal: PtyTerminal | null = null;
const ROOT_UID = 0;
const ROOT_GID = 0;
const ROOT_HOME = "/root";
const DEMO_UID = 1000;
const DEMO_GID = 1000;
const DEMO_HOME = "/home/user";
const SHELL_ENV = [
  `HOME=${DEMO_HOME}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "USER=user",
  "LOGNAME=user",
  "PS1=bash$ ",
  `HISTFILE=${DEMO_HOME}/.bash_history`,
];

function prepareDemoFs(fs: MemoryFileSystem): void {
  try { fs.mkdir("/home", 0o755); } catch {}
  try { fs.mkdir(DEMO_HOME, 0o755); } catch {}
  fs.chown(DEMO_HOME, DEMO_UID, DEMO_GID);
  fs.chmod(DEMO_HOME, 0o755);
  try { fs.mkdir(ROOT_HOME, 0o700); } catch {}
  fs.chown(ROOT_HOME, ROOT_UID, ROOT_GID);
  fs.chmod(ROOT_HOME, 0o700);
}

async function startInteractiveShell() {
  startBtn.disabled = true;
  stopBtn.disabled = false;

  // Clear the container for xterm.js
  terminalContainer.innerHTML = "";

  try {
    await loadBinaries();

    setStatus("Starting shell...", "running");

    const memfs = prepareShellFs();
    const info = formatLazyInfo(memfs);

    const kernel = new BrowserKernel({ memfs });

    await kernel.init(kernelBytes!);
    activeKernel = kernel;

    // Create PTY terminal
    const ptyTerminal = new PtyTerminal(terminalContainer, kernel);
    activePtyTerminal = ptyTerminal;

    if (info) {
      ptyTerminal.terminal.writeln(info.trimEnd());
    }

    hideStatus();
    ptyTerminal.terminal.focus();

    // Spawn bash as an interactive login shell. Terminal emulators
    // (xterm, gnome-terminal, ssh, etc.) typically spawn bash as a login
    // shell too, so this matches what users expect: /etc/profile is
    // sourced, aliases and environment set up there are applied.
    const exitCode = await ptyTerminal.spawn(bashBytes!, ["bash", "-l", "-i"], {
      env: SHELL_ENV,
      cwd: DEMO_HOME,
      uid: DEMO_UID,
      gid: DEMO_GID,
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
    await loadBinaries();

    const commands = codeEl.value;
    setStatus("Running shell...", "running");

    const memfs = prepareShellFs();
    appendBatchOutput(formatLazyInfo(memfs), "info");

    const kernel = new BrowserKernel({
      memfs,
      onStdout: (data) => appendBatchOutput(decoder.decode(data)),
      onStderr: (data) => appendBatchOutput(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes!);

    const exitCode = await kernel.spawn(bashBytes!, ["bash"], {
      env: SHELL_ENV.filter((kv) => !kv.startsWith("TERM=") && !kv.startsWith("PS1=")).concat("TERM=dumb"),
      cwd: DEMO_HOME,
      uid: DEMO_UID,
      gid: DEMO_GID,
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
