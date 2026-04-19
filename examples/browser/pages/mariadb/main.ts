/**
 * MariaDB browser demo — runs MariaDB 10.5 inside the POSIX kernel,
 * bootstraps system tables, starts the server, and lets users run SQL
 * queries via a minimal MySQL wire protocol client.
 *
 * Uses SystemInit to orchestrate boot from /etc/init.d/ service descriptors.
 *
 * The VFS image (mariadb.vfs) is built at build time and contains the
 * mariadbd binary, dash, bootstrap SQL, data directories, shell symlinks,
 * and init descriptors. At runtime we restore the image and register
 * lazy binaries.
 *
 * Process layout:
 *   pid 1: mariadbd --bootstrap (oneshot, terminated after stdin consumed)
 *   pid 2: mariadbd server (daemon, spawns 5 background threads)
 *   pid N: dash -i (interactive shell with PTY)
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { SystemInit } from "../../lib/init/system-init";
import { MySqlBrowserClient } from "../../lib/mysql-client";
import { writeInitDescriptor } from "../../lib/init/vfs-utils";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import "@xterm/xterm/css/xterm.css";
import "../../lib/terminal-panel.css";

// Optional shell helpers — missing ones simply aren't registered as lazy files.
// Using import.meta.glob (rather than static `?url` imports) lets the page load
// even when coreutils/grep/sed haven't been built yet.
const OPTIONAL_URLS = {
  ...import.meta.glob("../../../../examples/libs/coreutils/bin/coreutils.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../examples/libs/grep/bin/grep.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../examples/libs/sed/bin/sed.wasm", {
    query: "?url", import: "default",
  }),
} as Record<string, () => Promise<string>>;

async function loadOptionalUrl(relPath: string): Promise<string | null> {
  const loader = OPTIONAL_URLS[relPath];
  return loader ? await loader() : null;
}

const VFS_IMAGE_URL_32 = import.meta.env.BASE_URL + "mariadb.vfs";
const VFS_IMAGE_URL_64 = import.meta.env.BASE_URL + "mariadb-64.vfs";

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const executeBtn = document.getElementById("execute") as HTMLButtonElement;
const sqlInput = document.getElementById("sql") as HTMLTextAreaElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const resultDiv = document.getElementById("result") as HTMLDivElement;
const examplesSelect = document.getElementById("examples") as HTMLSelectElement;
const engineSelect = document.getElementById("engine") as HTMLSelectElement;
const archSelect = document.getElementById("arch") as HTMLSelectElement;
const terminalPanel = document.getElementById("terminal-panel") as HTMLDivElement;

const decoder = new TextDecoder();

function appendLog(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

function setStatus(text: string, type: "loading" | "running" | "error") {
  statusDiv.style.display = "block";
  statusDiv.textContent = text;
  statusDiv.className = `status ${type}`;
}

// Example queries — engine is filled dynamically at selection time
function getExamples(): Record<string, string> {
  const eng = engineSelect.value || "Aria";
  return {
  version: "SELECT VERSION(), @@version_comment;",
  create: `CREATE TABLE IF NOT EXISTS test.users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=${eng};`,
  insert: `INSERT INTO test.users (name, email) VALUES
  ('Alice', 'alice@example.com'),
  ('Bob', 'bob@example.com'),
  ('Charlie', 'charlie@example.com');`,
  select: "SELECT * FROM test.users;",
  show: "SHOW TABLES FROM test;",
  databases: "SHOW DATABASES;",
  };
}

let kernel: BrowserKernel | null = null;
let init: SystemInit | null = null;
let mysqlClient: MySqlBrowserClient | null = null;

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

async function start() {
  const engine = engineSelect.value;
  const arch = archSelect.value as "wasm32" | "wasm64";
  const vfsUrl = arch === "wasm64" ? VFS_IMAGE_URL_64 : VFS_IMAGE_URL_32;
  const archLabel = arch === "wasm64" ? "64-bit" : "32-bit";
  const buildHint = arch === "wasm64"
    ? "bash examples/browser/scripts/build-mariadb-vfs-image.sh --wasm64"
    : "bash examples/browser/scripts/build-mariadb-vfs-image.sh";
  startBtn.disabled = true;
  engineSelect.disabled = true;
  archSelect.disabled = true;
  log.textContent = "";
  setStatus(`Loading MariaDB (${archLabel})...`, "loading");

  try {
    // Resolve optional shell helper URLs (may be null if not built)
    const coreutilsWasmUrl = await loadOptionalUrl("../../../../examples/libs/coreutils/bin/coreutils.wasm");
    const grepWasmUrl = await loadOptionalUrl("../../../../examples/libs/grep/bin/grep.wasm");
    const sedWasmUrl = await loadOptionalUrl("../../../../examples/libs/sed/bin/sed.wasm");

    // Fetch kernel wasm, VFS image, and lazy binary sizes in parallel
    appendLog(`Fetching kernel wasm and ${archLabel} VFS image...\n`, "info");
    const [kernelBytes, vfsImageBuf, coreutilsSize, grepSize, sedSize] =
      await Promise.all([
        fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
        fetch(vfsUrl).then((r) => {
          if (!r.ok) {
            throw new Error(
              `Failed to load VFS image from ${vfsUrl} (${r.status}). ` +
              `Run: ${buildHint}`
            );
          }
          return r.arrayBuffer();
        }),
        coreutilsWasmUrl ? fetchSize(coreutilsWasmUrl) : Promise.resolve(0),
        grepWasmUrl ? fetchSize(grepWasmUrl) : Promise.resolve(0),
        sedWasmUrl ? fetchSize(sedWasmUrl) : Promise.resolve(0),
      ]);

    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
        `VFS image (${archLabel}): ${(vfsImageBuf.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    // Restore MemoryFileSystem from the pre-built VFS image
    appendLog("Restoring VFS from image...\n", "info");
    const maxFsSize = 1024 * 1024 * 1024; // 1GB max growth
    const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsImageBuf), {
      maxByteLength: maxFsSize,
    });

    // Create kernel with pre-built filesystem
    kernel = new BrowserKernel({
      memfs,
      maxWorkers: 12,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Register lazy binaries — the image already has all symlinks
    const lazyFiles: Array<{ path: string; url: string; size: number; mode?: number }> = [];
    if (coreutilsWasmUrl && coreutilsSize > 0) {
      lazyFiles.push({ path: "/bin/coreutils", url: coreutilsWasmUrl, size: coreutilsSize, mode: 0o755 });
    }
    if (grepWasmUrl && grepSize > 0) {
      lazyFiles.push({ path: "/usr/bin/grep", url: grepWasmUrl, size: grepSize, mode: 0o755 });
    }
    if (sedWasmUrl && sedSize > 0) {
      lazyFiles.push({ path: "/usr/bin/sed", url: sedWasmUrl, size: sedSize, mode: 0o755 });
    }
    if (lazyFiles.length > 0) {
      kernel.registerLazyFiles(lazyFiles);
    }

    // Override init descriptors based on engine selection
    const commonMariadbArgs = [
      "/usr/sbin/mariadbd", "--no-defaults",
      "--datadir=/data", "--tmpdir=/data/tmp",
      `--default-storage-engine=${engine}`,
      "--skip-grant-tables",
      "--key-buffer-size=1048576", "--table-open-cache=10",
      "--sort-buffer-size=262144",
    ];
    const innodbArgs = engine === "InnoDB" ? [
      "--innodb-buffer-pool-size=8M",
      "--innodb-log-file-size=4M",
      "--innodb-log-buffer-size=1M",
      "--innodb-flush-log-at-trx-commit=2",
      "--innodb-buffer-pool-load-at-startup=OFF",
      "--innodb-buffer-pool-dump-at-shutdown=OFF",
    ] : [];

    writeInitDescriptor(memfs, "05-mariadb-bootstrap", {
      type: "oneshot",
      command: [...commonMariadbArgs, ...innodbArgs,
        "--bootstrap", "--skip-networking", "--log-warnings=0",
        "--log-error=/data/bootstrap.log",
      ].join(" "),
      stdin: "/etc/mariadb/bootstrap.sql",
      ready: "stdin-consumed",
      terminate: "true",
    });
    writeInitDescriptor(memfs, "10-mariadb", {
      type: "daemon",
      command: [...commonMariadbArgs, ...innodbArgs,
        "--skip-networking=0", "--port=3306",
        "--bind-address=0.0.0.0", "--socket=",
        "--max-connections=10", "--thread-handling=no-threads",
        "--log-error=/data/error.log",
      ].join(" "),
      depends: "mariadb-bootstrap",
      ready: "port:3306",
    });

    // Create SystemInit and boot
    setStatus(`Booting system (${engine}, ${archLabel})...`, "loading");
    init = new SystemInit(kernel, {
      onLog: (msg, level) => appendLog(msg + "\n", level === "info" ? "info" : "stderr"),
      terminalContainer: terminalPanel,
      onServiceReady: async (name) => {
        if (name === "mariadb-bootstrap") {
          appendLog("Bootstrap complete\n", "info");
        }
        if (name === "mariadb") {
          // Connect MySQL client with retry for handshake
          appendLog("Connecting MySQL client...\n", "info");
          const maxRetries = 10;
          for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
              mysqlClient = await MySqlBrowserClient.connect(kernel!, 3306);
              appendLog(`Connected! (attempt ${attempt})\n`, "info");
              break;
            } catch (e) {
              if (attempt === maxRetries) {
                throw new Error(`MySQL handshake failed after ${maxRetries} attempts: ${e}`);
              }
              appendLog(`Connect attempt ${attempt} failed, retrying...\n`, "info");
              await new Promise((r) => setTimeout(r, 2000));
            }
          }

          setStatus(`MariaDB running (${engine}, ${archLabel})! Execute SQL queries.`, "running");
          executeBtn.disabled = false;

          // Auto-run the default query
          await executeQuery();
        }
      },
    });

    await init.boot();
  } catch (e: any) {
    const msg = e?.message || String(e);
    appendLog(`\nError: ${msg}\n`, "stderr");
    setStatus(`Error: ${msg}`, "error");
    console.error(e);
    startBtn.disabled = false;
    engineSelect.disabled = false;
    archSelect.disabled = false;
  }
}

async function executeQuery() {
  const sql = sqlInput.value.trim();
  if (!sql || !mysqlClient) return;

  executeBtn.disabled = true;
  appendLog(`\n> ${sql}\n`, "info");

  try {
    const result = await mysqlClient.query(sql);

    if (result.columns.length > 0) {
      // Build HTML table for result set
      let html = `<table class="result-table"><thead><tr>`;
      for (const col of result.columns) {
        html += `<th>${escapeHtml(col)}</th>`;
      }
      html += `</tr></thead><tbody>`;
      for (const row of result.rows) {
        html += `<tr>`;
        for (const cell of row) {
          html += `<td>${escapeHtml(cell)}</td>`;
        }
        html += `</tr>`;
      }
      html += `</tbody></table>`;
      html += `<p style="margin-top:0.5rem;color:#666;font-size:0.8rem">${result.rows.length} row(s)</p>`;
      resultDiv.innerHTML = html;
    } else {
      // Non-query result (INSERT, CREATE, etc.)
      const msg = result.info || `OK, ${result.affectedRows ?? 0} row(s) affected`;
      resultDiv.innerHTML = `<p style="color:#4a4">${escapeHtml(msg)}</p>`;
    }

    appendLog(`Query OK\n`, "info");
  } catch (e: any) {
    resultDiv.innerHTML = `<p style="color:red">${escapeHtml(e.message)}</p>`;
    appendLog(`Error: ${e.message}\n`, "stderr");
  } finally {
    executeBtn.disabled = false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Wire up controls
startBtn.addEventListener("click", start);
executeBtn.addEventListener("click", executeQuery);

examplesSelect.addEventListener("change", () => {
  const key = examplesSelect.value;
  const examples = getExamples();
  if (key && examples[key]) {
    sqlInput.value = examples[key];
  }
  examplesSelect.value = "";
});

sqlInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !executeBtn.disabled) {
    e.preventDefault();
    executeQuery();
  }
});
