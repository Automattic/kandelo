/**
 * MariaDB browser demo — runs MariaDB 10.5 inside the POSIX kernel,
 * bootstraps system tables, starts the server, and lets users run SQL
 * queries via a minimal MySQL wire protocol client.
 *
 * Uses SystemInit to orchestrate boot from /etc/init.d/ service descriptors.
 *
 * Process layout:
 *   pid 1: mariadbd --bootstrap (oneshot, terminated after stdin consumed)
 *   pid 2: mariadbd server (daemon, spawns 5 background threads)
 *   pid N: dash -i (interactive shell with PTY)
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { SystemInit } from "../../lib/init/system-init";
import { populateMariadbDirs } from "../../lib/init/mariadb-config";
import {
  populateShellBinaries,
  type BinaryDef,
  COREUTILS_NAMES,
} from "../../lib/init/shell-binaries";
import {
  writeVfsBinary,
  writeVfsFile,
  writeInitDescriptor,
  ensureDir,
} from "../../lib/init/vfs-utils";
import { MySqlBrowserClient } from "../../lib/mysql-client";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import mariadbWasmUrl from "../../../../examples/libs/mariadb/mariadb-install/bin/mariadbd.wasm?url";
import systemTablesUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql?url";
import systemDataUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql?url";
import dashWasmUrl from "../../../../examples/libs/dash/bin/dash.wasm?url";
import coreutilsWasmUrl from "../../../../examples/libs/coreutils/bin/coreutils.wasm?url";
import grepWasmUrl from "../../../../examples/libs/grep/bin/grep.wasm?url";
import sedWasmUrl from "../../../../examples/libs/sed/bin/sed.wasm?url";
import "@xterm/xterm/css/xterm.css";
import "../../lib/terminal-panel.css";

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const executeBtn = document.getElementById("execute") as HTMLButtonElement;
const sqlInput = document.getElementById("sql") as HTMLTextAreaElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const resultDiv = document.getElementById("result") as HTMLDivElement;
const examplesSelect = document.getElementById("examples") as HTMLSelectElement;
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

// Example queries
const EXAMPLES: Record<string, string> = {
  version: "SELECT VERSION(), @@version_comment;",
  create: `CREATE TABLE IF NOT EXISTS test.users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(200),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=Aria;`,
  insert: `INSERT INTO test.users (name, email) VALUES
  ('Alice', 'alice@example.com'),
  ('Bob', 'bob@example.com'),
  ('Charlie', 'charlie@example.com');`,
  select: "SELECT * FROM test.users;",
  show: "SHOW TABLES FROM test;",
  databases: "SHOW DATABASES;",
};

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
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading MariaDB...", "loading");

  try {
    // Fetch all resources in parallel — MariaDB eagerly (written to VFS)
    appendLog("Fetching resources...\n", "info");
    const [kernelBytes, mariadbBytes, systemTablesSql, systemDataSql, dashBytes] =
      await Promise.all([
        fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
        fetch(mariadbWasmUrl).then((r) => r.arrayBuffer()),
        fetch(systemTablesUrl).then((r) => r.text()),
        fetch(systemDataUrl).then((r) => r.text()),
        fetch(dashWasmUrl).then((r) => r.arrayBuffer()),
      ]);

    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
        `MariaDB: ${(mariadbBytes.byteLength / (1024 * 1024)).toFixed(1)}MB, ` +
        `dash: ${(dashBytes.byteLength / 1024).toFixed(0)}KB\n`,
      "info",
    );

    // Fetch sizes for shell utility binaries
    const lazyDefs = [
      { url: coreutilsWasmUrl, path: "/bin/coreutils", symlinks: [...COREUTILS_NAMES, "["].flatMap(n => [`/bin/${n}`, `/usr/bin/${n}`]) },
      { url: grepWasmUrl, path: "/usr/bin/grep", symlinks: ["/bin/grep", "/usr/bin/egrep", "/bin/egrep", "/usr/bin/fgrep", "/bin/fgrep"] },
      { url: sedWasmUrl, path: "/usr/bin/sed", symlinks: ["/bin/sed"] },
    ];
    const sizes = await Promise.all(lazyDefs.map((d) => fetchSize(d.url)));
    const lazyBinaries: BinaryDef[] = [];
    for (let i = 0; i < lazyDefs.length; i++) {
      if (sizes[i] > 0) {
        lazyBinaries.push({ ...lazyDefs[i], size: sizes[i] });
      }
    }

    // Create kernel — thread module is auto-compiled on first clone()
    kernel = new BrowserKernel({
      maxWorkers: 12,
      fsSize: 64 * 1024 * 1024, // 64MB for bootstrap system tables + data
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Populate VFS
    appendLog("Populating filesystem...\n", "info");
    const fs = kernel.fs;

    // Shell binaries (dash eager, utilities lazy)
    populateShellBinaries(kernel, dashBytes, lazyBinaries);

    // MariaDB binary — write eagerly since we already fetched it
    ensureDir(fs, "/usr/sbin");
    writeVfsBinary(fs, "/usr/sbin/mariadbd", new Uint8Array(mariadbBytes));

    // MariaDB data directories
    populateMariadbDirs(fs);

    // Write the bootstrap SQL to VFS
    const bootstrapSql = `use mysql;\n${systemTablesSql}\n${systemDataSql}\nCREATE DATABASE IF NOT EXISTS test;\n`;
    ensureDir(fs, "/etc/mariadb");
    writeVfsFile(fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

    // Write init service descriptors
    writeInitDescriptor(fs, "05-mariadb-bootstrap", {
      type: "oneshot",
      command: "/usr/sbin/mariadbd --bootstrap --datadir=/data --tmpdir=/data/tmp --skip-networking --log-error=/data/bootstrap.log",
      stdin: "/etc/mariadb/bootstrap.sql",
      ready: "stdin-consumed",
      terminate: "true",
    });

    writeInitDescriptor(fs, "10-mariadb", {
      type: "daemon",
      command: "/usr/sbin/mariadbd --datadir=/data --tmpdir=/data/tmp --skip-networking=0 --port=3306 --thread-handling=no-threads --skip-grant-tables --default-storage-engine=Aria --log-error=/data/error.log",
      depends: "mariadb-bootstrap",
      ready: "port:3306",
    });

    writeInitDescriptor(fs, "99-shell", {
      type: "interactive",
      command: "/bin/dash -i",
      env: "TERM=xterm-256color PS1=\\w\\$\\  HOME=/root PATH=/usr/local/bin:/usr/bin:/bin",
      pty: "true",
      cwd: "/root",
    });

    // Create SystemInit and boot
    setStatus("Booting system...", "loading");
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

          setStatus("MariaDB running! Execute SQL queries.", "running");
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
  if (key && EXAMPLES[key]) {
    sqlInput.value = EXAMPLES[key];
  }
  examplesSelect.value = "";
});

sqlInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !executeBtn.disabled) {
    e.preventDefault();
    executeQuery();
  }
});
