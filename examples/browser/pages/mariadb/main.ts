/**
 * MariaDB browser demo — boots a service-demo VFS image with dinit
 * as PID 1. The image bakes both Aria and InnoDB service trees;
 * dinit picks one based on the positional argv we pass:
 *
 *   /sbin/dinit --container <engine>-mariadb
 *
 * dinit walks the depends-on chain, runs the matching scripted
 * bootstrap (mariadbd --bootstrap < bootstrap.sql), and then starts
 * the daemon. Once port 3306 is listening, the page connects via
 * the MySQL wire protocol over kernel-loopback TCP and runs SQL
 * queries the user types into the editor.
 *
 * Process layout once boot completes:
 *   pid 1: dinit (PID 1, --container)
 *   pid 100+: <engine>-bootstrap (scripted, exits cleanly)
 *   pid 100+: <engine>-mariadb (process, daemon + 5 worker threads)
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { MySqlBrowserClient } from "../../lib/mysql-client";
import kernelWasmUrl from "@kernel-wasm?url";
import "../../lib/terminal-panel.css";

const VFS_IMAGE_URL_32 = import.meta.env.BASE_URL + "mariadb.vfs";
const VFS_IMAGE_URL_64 = import.meta.env.BASE_URL + "mariadb-64.vfs";
const MYSQL_PORT = 3306;

const log = document.getElementById("log") as HTMLPreElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const executeBtn = document.getElementById("execute") as HTMLButtonElement;
const sqlInput = document.getElementById("sql") as HTMLTextAreaElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const resultDiv = document.getElementById("result") as HTMLDivElement;
const examplesSelect = document.getElementById("examples") as HTMLSelectElement;
const engineSelect = document.getElementById("engine") as HTMLSelectElement;
const archSelect = document.getElementById("arch") as HTMLSelectElement;

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
let mysqlClient: MySqlBrowserClient | null = null;

async function start() {
  const engine = engineSelect.value;
  const arch = archSelect.value as "wasm32" | "wasm64";
  const vfsUrl = arch === "wasm64" ? VFS_IMAGE_URL_64 : VFS_IMAGE_URL_32;
  const archLabel = arch === "wasm64" ? "64-bit" : "32-bit";
  const buildHint = arch === "wasm64"
    ? "bash examples/browser/scripts/build-mariadb-vfs-image.sh --wasm64"
    : "bash examples/browser/scripts/build-mariadb-vfs-image.sh";

  const tag = engine === "InnoDB" ? "innodb" : "aria";
  const targetService = `${tag}-mariadb`;

  startBtn.disabled = true;
  engineSelect.disabled = true;
  archSelect.disabled = true;
  log.textContent = "";
  setStatus(`Loading MariaDB (${engine}, ${archLabel})...`, "loading");

  try {
    appendLog(`Fetching kernel + ${archLabel} VFS image...\n`, "info");
    const [kernelBytes, vfsImageBuf] = await Promise.all([
      fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
      fetch(vfsUrl).then((r) => {
        if (!r.ok) {
          throw new Error(
            `Failed to load VFS image from ${vfsUrl} (${r.status}). Run: ${buildHint}`,
          );
        }
        return r.arrayBuffer();
      }),
    ]);
    const vfsImage = new Uint8Array(vfsImageBuf);
    appendLog(
      `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB, ` +
      `VFS (${archLabel}): ${(vfsImage.byteLength / (1024 * 1024)).toFixed(1)}MB\n`,
      "info",
    );

    setStatus(`Booting kernel with /sbin/dinit (${targetService})...`, "loading");

    let portReadyResolve: (() => void) | null = null;
    const portReady = new Promise<void>((resolve) => { portReadyResolve = resolve; });

    kernel = new BrowserKernel({
      kernelOwnedFs: true,
      maxWorkers: 12,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
      onListenTcp: (_pid, _fd, port) => {
        appendLog(`service listening on :${port}\n`, "info");
        if (port === MYSQL_PORT) portReadyResolve?.();
      },
    });

    const { exit } = await kernel.boot({
      kernelWasm: kernelBytes,
      vfsImage,
      argv: ["/sbin/dinit", "--container", "-p", "/tmp/dinitctl", targetService],
      env: ["HOME=/root", "TERM=xterm-256color", "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"],
    });

    // Wait for the daemon to bind 3306 (dinit considers a process service
    // started right after exec(), which is before the bind/listen finishes).
    await portReady;
    appendLog("MariaDB listening; connecting MySQL client...\n", "info");

    // Handshake retry: the listener is up but the server may still be
    // initializing accept-loop / threads. Retry the wire protocol greet.
    const maxRetries = 10;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        mysqlClient = await MySqlBrowserClient.connect(kernel, MYSQL_PORT);
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
    await executeQuery();

    // Surface dinit exit if it happens — should not while the demo is
    // active, since dinit stays up in --container mode.
    exit.then((code) => {
      appendLog(`\ndinit exited with code ${code}\n`, "info");
      setStatus(`dinit exited with code ${code}`, "error");
    });
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
