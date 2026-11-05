import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { Database, QueryResult } from "../store.ts";
const execute = promisify(execFile);
export async function mysql() {
  const tools = process.env.KANDELO_SIGNALLING_TEST_TOOLS;
  if (!tools) throw new Error("Build test/tools.nix and set KANDELO_SIGNALLING_TEST_TOOLS; these tests require real MySQL/MariaDB.");
  const root = await mkdtemp(join(tmpdir(), "ksql-")); const socket = join(root, "db.sock");
  const binary = (name: string) => join(tools, "bin", name);
  await execute(binary("mariadb-install-db"), ["--no-defaults", `--datadir=${root}`, "--auth-root-authentication-method=normal"], { maxBuffer: 4 * 1024 * 1024 });
  const child = spawn(binary("mariadbd"), ["--no-defaults", `--datadir=${root}`, `--socket=${socket}`, "--skip-networking", "--innodb-buffer-pool-size=32M", "--max-allowed-packet=32M", `--log-error=${join(root, "error.log")}`], { stdio: "ignore" });
  // Use stdin: request bodies can exceed the operating system's argv ceiling.
  async function command(sql: string): Promise<string> {
    const p = spawn(binary("mariadb"), ["--no-defaults", `--socket=${socket}`, "--user=root", "--batch", "--raw", "--default-character-set=utf8mb4", "--max-allowed-packet=32M"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = ""; p.stdout.setEncoding("utf8"); p.stderr.setEncoding("utf8");
    p.stdout.on("data", s => out += s); p.stderr.on("data", s => err += s); p.stdin.on("error", () => {}); p.stdin.end(sql);
    const [code] = await once(p, "exit"); if (code !== 0) throw new Error(err); return out;
  }
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(await readFile(join(root, "error.log"), "utf8"));
    try { await command("SELECT 1;"); ready = true; break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  if (!ready) throw new Error("MySQL did not become ready");
  await command("CREATE DATABASE signalling CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;");
  const sqlValue = (v: string | number) => typeof v === "number" ? String(v) : `CONVERT(0x${Buffer.from(v).toString("hex")} USING utf8mb4)`;
  async function query(sql: string, values: (string | number)[] = []): Promise<QueryResult> {
    let i = 0; const bound = sql.replace(/\?/g, () => sqlValue(values[i++]));
    if (i !== values.length) throw new Error("Wrong SQL parameter count");
    const output = await command(`USE signalling; ${bound}; SELECT CONCAT('__CHANGES__', ROW_COUNT());`);
    const lines = output.trimEnd().split("\n"); const marker = lines.findIndex(l => /^__CHANGES__-?\d+$/.test(l));
    const changes = Number(lines[marker]?.slice(11));
    const data = lines.slice(0, Math.max(0, marker - 1));
    const headers = data.shift()?.split("\t") ?? [];
    return { success: true, meta: { changes: Math.max(0, changes) }, results: data.map(line => Object.fromEntries(line.split("\t").map((value, index) => [headers[index], value === "NULL" ? null : value]))) };
  }
  const db: Database = { prepare(sql) { return { all: () => query(sql), bind: (...values) => ({ all: () => query(sql, values) }) }; } };
  return { db, query, tools, async close() { child.kill("SIGTERM"); await once(child, "exit"); await rm(root, { recursive: true, force: true }); } };
}
