import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** One identity inherited by config reloads, workers, and the owned server. */
export function playwrightRun(configDirectory: string): { outputDir: string } {
  const id = process.env.KANDELO_PLAYWRIGHT_RUN_ID ??= randomUUID();
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid Playwright run id");
  const root = join(configDirectory, "test-results", id);
  mkdirSync(root, { recursive: true });
  // CLI-selected file reporters otherwise overwrite cwd-wide defaults. Explicit
  // reporter paths remain caller-owned, just like an explicit --output path.
  process.env.PLAYWRIGHT_HTML_OUTPUT_DIR ??= join(root, "html");
  process.env.PLAYWRIGHT_BLOB_OUTPUT_DIR ??= join(root, "blob");
  process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ??= join(root, "report.json");
  process.env.PLAYWRIGHT_JUNIT_OUTPUT_FILE ??= join(root, "junit.xml");
  return { outputDir: join(root, "artifacts") };
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
