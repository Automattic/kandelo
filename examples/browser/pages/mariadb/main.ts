/**
 * MariaDB browser demo — runs MariaDB 10.5 inside the POSIX kernel,
 * bootstraps system tables, starts the server, and lets users run SQL
 * queries via a minimal MySQL wire protocol client.
 *
 * Process layout:
 *   pid 1: mariadbd (main process, spawns 5 background threads)
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { loadFiles } from "../../lib/fs-loader";
import { patchWasmForThread } from "../../../../host/src/worker-main";
import { MySqlBrowserClient } from "../../lib/mysql-client";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import mariadbWasmUrl from "../../../../examples/libs/mariadb/mariadb-install/bin/mariadbd.wasm?url";
import systemTablesUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql?url";
import systemDataUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql?url";

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const executeBtn = document.getElementById("execute") as HTMLButtonElement;
const sqlInput = document.getElementById("sql") as HTMLTextAreaElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const resultDiv = document.getElementById("result") as HTMLDivElement;
const examplesSelect = document.getElementById("examples") as HTMLSelectElement;

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
let mysqlClient: MySqlBrowserClient | null = null;

async function start() {
  startBtn.disabled = true;
  log.textContent = "";
  setStatus("Loading MariaDB...", "loading");

  try {
    // Fetch all resources in parallel
    appendLog("Fetching resources...\n", "info");
    const [kernelBytes, mariadbBytes, systemTablesSql, systemDataSql] =
      await Promise.all([
        fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
        fetch(mariadbWasmUrl).then((r) => r.arrayBuffer()),
        fetch(systemTablesUrl).then((r) => r.text()),
        fetch(systemDataUrl).then((r) => r.text()),
      ]);

    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
        `MariaDB: ${(mariadbBytes.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    // Pre-compile thread module for MariaDB's background threads
    appendLog("Pre-compiling thread module...\n", "info");
    setStatus("Pre-compiling thread module...", "loading");
    const threadPatchedBytes = patchWasmForThread(mariadbBytes);
    const threadModule = await WebAssembly.compile(threadPatchedBytes);
    appendLog("Thread module ready\n", "info");

    // Create kernel with thread support
    kernel = new BrowserKernel({
      maxWorkers: 12,
      fsSize: 32 * 1024 * 1024,
      threadModule,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });

    await kernel.init(kernelBytes);

    // Create data directory structure
    const fs = kernel.fs;
    for (const dir of [
      "/data",
      "/data/mysql",
      "/data/tmp",
      "/data/test",
    ]) {
      try { fs.mkdir(dir, 0o755); } catch { /* exists */ }
    }

    // --- Phase 1: Bootstrap system tables ---
    setStatus("Bootstrapping MariaDB system tables...", "loading");
    appendLog("Bootstrapping system tables (this takes ~30s)...\n", "info");

    const bootstrapSql = `use mysql;\n${systemTablesSql}\n${systemDataSql}\n`;
    const bootstrapStdin = new TextEncoder().encode(bootstrapSql);

    const bootstrapExit = kernel.spawn(mariadbBytes, [
      "mariadbd",
      "--no-defaults",
      "--datadir=/data",
      "--tmpdir=/data/tmp",
      "--default-storage-engine=Aria",
      "--skip-grant-tables",
      "--key-buffer-size=1048576",
      "--table-open-cache=10",
      "--sort-buffer-size=262144",
      "--bootstrap",
      "--log-warnings=0",
    ], {
      stdin: bootstrapStdin,
    });

    // Wait for bootstrap (with timeout)
    const bootstrapTimeout = new Promise<number>((r) =>
      setTimeout(() => r(-1), 60000),
    );
    const bootstrapResult = await Promise.race([bootstrapExit, bootstrapTimeout]);

    if (bootstrapResult === -1) {
      appendLog("Bootstrap timed out, proceeding...\n", "info");
    } else {
      appendLog(`Bootstrap exited with code ${bootstrapResult}\n`, "info");
    }

    // Create test database
    appendLog("Creating test database...\n", "info");
    const createDbExit = kernel.spawn(mariadbBytes, [
      "mariadbd",
      "--no-defaults",
      "--datadir=/data",
      "--tmpdir=/data/tmp",
      "--default-storage-engine=Aria",
      "--skip-grant-tables",
      "--key-buffer-size=1048576",
      "--table-open-cache=10",
      "--sort-buffer-size=262144",
      "--bootstrap",
      "--log-warnings=0",
    ], {
      stdin: new TextEncoder().encode("CREATE DATABASE IF NOT EXISTS test;\n"),
    });

    const createTimeout = new Promise<number>((r) =>
      setTimeout(() => r(-1), 30000),
    );
    await Promise.race([createDbExit, createTimeout]);
    appendLog("Test database ready\n", "info");

    // --- Phase 2: Start server ---
    setStatus("Starting MariaDB server...", "loading");
    appendLog("Starting MariaDB server on 127.0.0.1:3306...\n", "info");

    kernel.spawn(mariadbBytes, [
      "mariadbd",
      "--no-defaults",
      "--datadir=/data",
      "--tmpdir=/data/tmp",
      "--default-storage-engine=Aria",
      "--skip-grant-tables",
      "--key-buffer-size=1048576",
      "--table-open-cache=10",
      "--sort-buffer-size=262144",
      "--thread-handling=no-threads",
      "--skip-networking=0",
      "--port=3306",
      "--bind-address=0.0.0.0",
      "--socket=",
      "--max-connections=10",
    ]);

    // Wait for server to initialize
    appendLog("Waiting for server to initialize...\n", "info");
    await new Promise((r) => setTimeout(r, 8000));

    // --- Phase 3: Connect MySQL client ---
    setStatus("Connecting to MariaDB...", "loading");
    appendLog("Connecting MySQL client...\n", "info");

    mysqlClient = await MySqlBrowserClient.connect(kernel, 3306);
    appendLog("Connected!\n", "info");

    setStatus("MariaDB running! Execute SQL queries.", "running");
    executeBtn.disabled = false;

    // Auto-run the default query
    await executeQuery();
  } catch (e) {
    appendLog(`\nError: ${e}\n`, "stderr");
    setStatus(`Error: ${e}`, "error");
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
