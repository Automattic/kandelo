import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { join, relative } from "node:path";

/** One identity inherited by config reloads, workers, and the owned server. */
export function playwrightRun(configDirectory: string): { outputDir: string; globalTeardown: string } {
  const id = process.env.KANDELO_PLAYWRIGHT_RUN_ID ??= randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid Playwright run id");
  const root = join(configDirectory, "test-results", id);
  const worktree = execFileSync("git", ["-C", configDirectory, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  // Conductor retains .context on archive; browser storage is disposable.
  const scratch = join(worktree, ".scratch", "validation-scratch", id);
  const manager = fileURLToPath(new URL("../scripts/validation_artifacts.py", import.meta.url));
  const record = JSON.parse(execFileSync("python3", [manager, "register",
    "--worktree", worktree, "--run-id", id, "--pid", String(process.pid),
    "--root", relative(worktree, root), "--root", relative(worktree, scratch),
    ...(process.argv.includes("--list") ? ["--inspection-only"] : []),
  ], { encoding: "utf8" }));
  process.env.KANDELO_VALIDATION_WORKTREE_ID = record.workspace_id;
  // Profiles and test-owned temporary files disappear with this worktree too.
  // Do not change the computer's global temporary directory.
  process.env.TMPDIR = join(scratch, "tmp");
  mkdirSync(process.env.TMPDIR, { recursive: true, mode: 0o700 });
  // CLI-selected file reporters otherwise overwrite cwd-wide defaults. Explicit
  // reporter paths remain caller-owned, just like an explicit --output path.
  process.env.PLAYWRIGHT_HTML_OUTPUT_DIR ??= join(root, "html");
  process.env.PLAYWRIGHT_BLOB_OUTPUT_DIR ??= join(root, "blob");
  process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ??= join(root, "report.json");
  process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ??= join(root, "junit.xml");
  return {
    outputDir: join(root, "artifacts"),
    globalTeardown: fileURLToPath(new URL("./playwright-run-teardown.ts", import.meta.url)),
  };
}

/** Ask the OS for a port; strictPort + no reuse make a lost bind race loud. */
export async function playwrightPort(value: string | undefined): Promise<number> {
  if (value !== undefined) {
    const port = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`Invalid Playwright port: ${value}`);
    }
    return port;
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing Playwright port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
