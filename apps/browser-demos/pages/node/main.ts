/**
 * Node browser demo — xterm.js terminal. Each Enter spawns a fresh
 * `node`/`npm` process so `npm install foo && node use-foo` always starts
 * from the on-disk VFS image. Bare `node` instead drops into the
 * persistent SpiderMonkey-backed REPL; `\q` exits.
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { BrowserKernel } from "@host/browser-kernel-host";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import kernelWasmUrl from "@kernel-wasm?url";
import nodeWasmUrl from "@binaries/programs/wasm32/node.wasm?url";
import nodeVfsUrl from "@binaries/programs/wasm32/node-vfs.vfs.zst?url";
import "@xterm/xterm/css/xterm.css";

const terminalContainer = document.getElementById("terminal") as HTMLDivElement;
const presetsEl = document.getElementById("presets") as HTMLSelectElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;

const VFS_IMAGE_URL = nodeVfsUrl;
const NPM_RUNNER = "/usr/local/lib/kandelo/npm-runner.js";
const PROMPT = "\x1b[32m$\x1b[0m ";

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const DEMO_UID = 1000;
const DEMO_GID = 1000;
const DEMO_HOME = "/home/user";
const NODE_WORKDIR = "/work";
const SEEDED_NODE_WORKDIR_FILES = [`${NODE_WORKDIR}/package.json`];
const NODE_ENV = [
  `HOME=${DEMO_HOME}`,
  `PWD=${NODE_WORKDIR}`,
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  "USER=user",
  "LOGNAME=user",
  "SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
  "SSL_CERT_DIR=/etc/ssl/certs",
  "npm_config_cache=/tmp/.npm-cache",
  "npm_config_fund=false",
  "npm_config_audit=false",
  "npm_config_progress=false",
  "npm_config_update_notifier=false",
  "NPM_CONFIG_FUND=false",
  "NPM_CONFIG_AUDIT=false",
  "NPM_CONFIG_PROGRESS=false",
  "NPM_CONFIG_UPDATE_NOTIFIER=false",
];

function prepareNodeFs(fs: MemoryFileSystem): void {
  for (const path of ["/home", DEMO_HOME, NODE_WORKDIR]) {
    try { fs.mkdir(path, 0o755); } catch {}
  }
  fs.chown(DEMO_HOME, DEMO_UID, DEMO_GID);
  fs.chmod(DEMO_HOME, 0o755);
  fs.chown(NODE_WORKDIR, DEMO_UID, DEMO_GID);
  fs.chmod(NODE_WORKDIR, 0o755);
  for (const path of SEEDED_NODE_WORKDIR_FILES) {
    try {
      fs.chown(path, DEMO_UID, DEMO_GID);
      fs.chmod(path, 0o644);
    } catch {}
  }
}

let kernelBytes: ArrayBuffer | null = null;
let nodeBytes: ArrayBuffer | null = null;
let vfsImageBuf: ArrayBuffer | null = null;

// Set while a persistent REPL process is running; xterm input is pumped
// straight into its stdin and lineBuf editing is bypassed.
let repl: { kernel: BrowserKernel; pid: number } | null = null;

// --- Terminal setup ---------------------------------------------------------

const term = new Terminal({
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 13,
  theme: { background: "#0d1117", foreground: "#c9d1d9", cursor: "#c9d1d9" },
  cursorBlink: true,
  convertEol: true,
});
const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(terminalContainer);
fitAddon.fit();
window.addEventListener("resize", () => fitAddon.fit());

function write(s: string) { term.write(s); }
function writeln(s: string) { term.writeln(s); }

// --- Line buffer + history --------------------------------------------------

let lineBuf = "";
let cursor = 0; // position within lineBuf
let busy = false;
const history: string[] = [];
let histIdx = 0;

function redrawLine() {
  write("\r\x1b[K");
  write(PROMPT);
  write(lineBuf);
  const back = lineBuf.length - cursor;
  if (back > 0) write(`\x1b[${back}D`);
}

function newPrompt() {
  lineBuf = "";
  cursor = 0;
  histIdx = history.length;
  write("\r\n");
  write(PROMPT);
}

// --- Command dispatch -------------------------------------------------------

/**
 * Parse the typed line into argv. Returns null for anything that isn't a
 * recognised command — the runner prints a "command not found" in that case,
 * just like a real shell. Only `node`, `npm`, and `cowsay` are recognised
 * (cowsay is special-cased so the demo's chained preset reads naturally).
 */
function buildArgv(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed === "npm" || trimmed.startsWith("npm ")) {
    const rest = trimmed.slice(3).trim();
    const tokens = rest ? tokenize(rest) : [];
    const hasInstall = tokens[0] === "install" || tokens[0] === "i";
    // Route npm through plain HTTP via the sentinel host `proxy.local` so
    // registry traffic can use the host fetch bridge. tls-network-backend.ts
    // recognises the alias and routes the fetch through the cors-proxy (dev) or
    // service worker (prod) to https://registry.npmjs.org, and rewrites tarball
    // URLs in JSON responses to keep them on the alias too.
    //
    // "localhost" would NOT work: the kernel's synthetic /etc/hosts maps it to
    // 127.0.0.1 and the connect short-circuits to the in-process loopback path
    // (no listener → ECONNREFUSED).
    const extras = hasInstall
      ? ["--prefix", "/work", "--cache", "/tmp/.npm-cache",
         "--no-fund", "--no-audit", "--progress=false",
         "--registry=http://proxy.local/"]
      : [];
    return ["node", NPM_RUNNER, "npm", ...tokens, ...extras];
  }

  if (trimmed === "node" || trimmed.startsWith("node ")) {
    return tokenize(trimmed);
  }

  // cowsay: invoke the npm-installed CLI directly. We don't have a real
  // PATH/exec lookup, so this stays a hard-coded shortcut for the demo.
  if (trimmed === "cowsay" || trimmed.startsWith("cowsay ")) {
    const rest = trimmed.slice(6).trim();
    return ["node", "/work/node_modules/cowsay/cli.js", ...tokenize(rest)];
  }

  return null;
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c as '"' | "'";
    } else if (c === " " || c === "\t") {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function loadBinaries(): Promise<void> {
  if (kernelBytes && nodeBytes && vfsImageBuf) return;

  writeln("\x1b[90mLoading kernel, node, and VFS image...\x1b[0m");
  const [kernelResult, nodeResult, vfsResult] = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(nodeWasmUrl).then((r) => r.arrayBuffer()),
    fetch(VFS_IMAGE_URL).then((r) => {
      if (!r.ok) {
        throw new Error(
          `Failed to load VFS image from ${VFS_IMAGE_URL} (${r.status}). ` +
          `Run: bash images/vfs/scripts/build-node-vfs-image.sh`,
        );
      }
      return r.arrayBuffer();
    }),
  ]);
  kernelBytes = kernelResult;
  nodeBytes = nodeResult;
  vfsImageBuf = vfsResult;

  writeln(
    `\x1b[90mKernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
    `node: ${(nodeBytes.byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
    `VFS image: ${(vfsImageBuf.byteLength / (1024 * 1024)).toFixed(1)}MB\x1b[0m`,
  );
}

async function enterRepl(): Promise<void> {
  busy = true;

  try {
    await loadBinaries();

    const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsImageBuf!), {
      maxByteLength: 256 * 1024 * 1024,
    });
    prepareNodeFs(memfs);

    const kernel = new BrowserKernel({
      memfs,
      onStdout: (data) => term.write(data),
      onStderr: (data) => term.write(`\x1b[31m${decoder.decode(data)}\x1b[0m`),
    });

    await kernel.init(kernelBytes!);

    // spawn() doesn't return the pid; nextPid is allocated synchronously
    // when spawn's body starts, so peeking before the call is safe.
    const pid = kernel.nextPid;
    const exitPromise = kernel.spawn(nodeBytes!, ["node"], {
      env: NODE_ENV,
      cwd: NODE_WORKDIR,
      uid: DEMO_UID,
      gid: DEMO_GID,
    });

    repl = { kernel, pid };

    const t0 = performance.now();
    const exit = await exitPromise;
    const dt = ((performance.now() - t0) / 1000).toFixed(2);
    write(`\r\n\x1b[90m[exit ${exit}, ${dt}s]\x1b[0m`);
  } catch (e) {
    write(`\r\n\x1b[31mError: ${e}\x1b[0m`);
    console.error(e);
  } finally {
    repl = null;
    busy = false;
    newPrompt();
    term.focus();
  }
}

async function runCommand(line: string): Promise<void> {
  busy = true;

  try {
    await loadBinaries();

    // One memfs is shared across `&&`-chained segments so an `npm install`
    // can populate node_modules and the next segment can run the CLI it
    // just installed.
    const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsImageBuf!), {
      maxByteLength: 256 * 1024 * 1024,
    });
    prepareNodeFs(memfs);

    const segments = line.split(/\s*&&\s*/).map((s) => s.trim()).filter(Boolean);
    let lastExit = 0;
    let lastDt = "0.00";

    for (const segment of segments) {
      const argv = buildArgv(segment);
      if (!argv) {
        const cmd = segment.split(/\s+/)[0] ?? "";
        write(`\x1b[31m${cmd}: command not found\x1b[0m`);
        return;
      }

      const kernel = new BrowserKernel({
        memfs,
        onStdout: (data) => term.write(data),
        onStderr: (data) => term.write(`\x1b[31m${decoder.decode(data)}\x1b[0m`),
      });

      await kernel.init(kernelBytes!);

      const t0 = performance.now();
      const pid = kernel.nextPid;
      const exitPromise = kernel.spawn(nodeBytes!, argv, {
        env: NODE_ENV,
        cwd: NODE_WORKDIR,
        uid: DEMO_UID,
        gid: DEMO_GID,
        pty: true,
        ptyCols: term.cols,
        ptyRows: term.rows,
      });
      kernel.onPtyOutput(pid, (data) => term.write(data));
      lastExit = await exitPromise;
      lastDt = ((performance.now() - t0) / 1000).toFixed(2);
      if (lastExit !== 0) break;
    }

    write(`\r\n\x1b[90m[exit ${lastExit}, ${lastDt}s]\x1b[0m`);
  } catch (e) {
    write(`\r\n\x1b[31mError: ${e}\x1b[0m`);
    console.error(e);
  } finally {
    busy = false;
    newPrompt();
    term.focus();
  }
}

// --- Input handling ---------------------------------------------------------

term.onData((data) => {
  if (repl) {
    repl.kernel.appendStdinData(repl.pid, encoder.encode(data));
    return;
  }
  if (busy) {
    // Allow Ctrl-C to abort... but we don't actually wire kill yet, so just
    // ignore input during a running command. (The kernel.spawn promise has
    // no cancel API exposed here.)
    return;
  }

  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = ch.charCodeAt(0);

    // Multi-char escape sequence (arrow keys, etc.)
    if (ch === "\x1b" && i + 2 < data.length && data[i + 1] === "[") {
      const arrow = data[i + 2];
      i += 2;
      if (arrow === "A") {           // up
        if (history.length === 0) continue;
        if (histIdx > 0) histIdx--;
        lineBuf = history[histIdx] ?? "";
        cursor = lineBuf.length;
        redrawLine();
      } else if (arrow === "B") {    // down
        if (histIdx < history.length) histIdx++;
        lineBuf = histIdx === history.length ? "" : history[histIdx];
        cursor = lineBuf.length;
        redrawLine();
      } else if (arrow === "C") {    // right
        if (cursor < lineBuf.length) { write("\x1b[C"); cursor++; }
      } else if (arrow === "D") {    // left
        if (cursor > 0) { write("\x1b[D"); cursor--; }
      }
      continue;
    }

    if (code === 13) {               // Enter
      const line = lineBuf;
      write("\r\n");
      if (line.trim()) {
        history.push(line);
        if (history.length > 200) history.shift();
        // async; new prompt printed in finally
        if (line.trim() === "node") enterRepl();
        else runCommand(line);
      } else {
        newPrompt();
      }
      return; // stop processing the rest of `data` for this event
    }
    if (code === 127 || code === 8) { // Backspace
      if (cursor > 0) {
        const atEnd = cursor === lineBuf.length;
        lineBuf = lineBuf.slice(0, cursor - 1) + lineBuf.slice(cursor);
        cursor--;
        // Erase-in-place when at end-of-line; full redraw only when shifting
        // characters to the left of the cursor.
        if (atEnd) write("\b \b");
        else redrawLine();
      }
      continue;
    }
    if (code === 3) {                // Ctrl-C
      write("^C");
      newPrompt();
      continue;
    }
    if (code === 12) {               // Ctrl-L
      term.clear();
      redrawLine();
      continue;
    }
    if (code === 1) {                // Ctrl-A — start of line
      if (cursor > 0) write(`\x1b[${cursor}D`);
      cursor = 0;
      continue;
    }
    if (code === 5) {                // Ctrl-E — end of line
      const ahead = lineBuf.length - cursor;
      if (ahead > 0) write(`\x1b[${ahead}C`);
      cursor = lineBuf.length;
      continue;
    }
    if (code >= 32) {                // Printable
      const atEnd = cursor === lineBuf.length;
      lineBuf = lineBuf.slice(0, cursor) + ch + lineBuf.slice(cursor);
      cursor++;
      // Append-at-end is the hot path: just echo the char so we don't
      // rewrite the prompt on every keystroke (which makes it appear to
      // flicker as the cursor lands on '$' between redraws).
      if (atEnd) write(ch);
      else redrawLine();
      continue;
    }
    // Ignore other control chars
  }
});

// --- Presets + clear --------------------------------------------------------

const PRESETS: Record<string, string> = {
  version: "node --version",
  hello: `node -e "console.log('hello from node-wasm')"`,
  process: `node -e "console.log(JSON.stringify(process.versions, null, 2))"`,
  fs: `node -e "console.log(require('fs').readdirSync('/usr/local/lib/npm').join('\\n'))"`,
  "npm-version": "npm --version",
  cowsay: "npm install cowsay && cowsay 'Hello Kandelo'",
};

presetsEl.addEventListener("change", () => {
  const key = presetsEl.value;
  if (key && PRESETS[key] && !busy) {
    lineBuf = PRESETS[key];
    cursor = lineBuf.length;
    redrawLine();
    term.focus();
  }
  presetsEl.value = "";
});

clearBtn.addEventListener("click", () => {
  term.clear();
  redrawLine();
  term.focus();
});

// --- Boot ------------------------------------------------------------------

writeln("\x1b[90mWelcome to node-wasm. Type a command (e.g. node --version, npm install cowsay && cowsay 'Hello Kandelo'). Type `node` alone to enter the REPL; \\q to exit.\x1b[0m");
write(PROMPT);
term.focus();
