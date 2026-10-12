/**
 * The development signalling server: the real `apps/signalling/piplet.php`,
 * run by PHP's built-in server and relayed same-origin.
 *
 * WHY the real piplet and not a Node stand-in: the piplet is the deployed
 * contract. A second implementation for development would let the app and
 * the server drift apart while every local test kept passing.
 *
 * WHY same-origin: the page's service worker relays cross-origin requests
 * through the CORS proxy, and a same-origin endpoint keeps the room traffic
 * out of that path entirely.
 *
 * PHP comes from `KANDELO_SIGNALLING_PHP`, then `php` on PATH, then the
 * app-scoped tools in `apps/signalling/tools.nix`, built with the Nix the
 * dev shell was entered with. Without PHP the endpoint
 * answers 503 with the reason, and the app says sessions are unavailable.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "vite";

const MAX_REQUEST_BYTES = 256 * 1024;
const FORWARDED_REQUEST_HEADERS = ["content-type", "x-kandelo-host-key"];
const START_TIMEOUT_MS = 10_000;

export function devSignallingPathForBase(base: string): string {
  return `${base.endsWith("/") ? base : `${base}/`}__kandelo_signalling`;
}

async function findPhp(repoRoot: string): Promise<string> {
  const configured = process.env.KANDELO_SIGNALLING_PHP;
  if (configured) return configured;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "php");
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  // The dev shell exports the Nix it was entered with; tools.nix reads the
  // repository flake, so it needs impure evaluation.
  const nix = process.env.KANDELO_NIX_BIN ?? "nix";
  const { stdout } = await promisify(execFile)(
    nix, ["build", "--impure", "--no-link", "--print-out-paths", "-f", path.join(repoRoot, "apps/signalling/tools.nix")],
    { maxBuffer: 1024 * 1024 },
  );
  const php = path.join(stdout.trim().split("\n").at(-1)!, "bin/php");
  if (!fs.existsSync(php)) throw new Error(`nix-build produced no ${php}`);
  return php;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`php exited with status ${child.exitCode}`);
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1", () => { socket.end(); resolve(true); });
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("php did not start listening");
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { reject(new Error("request too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function devSignallingServer(repoRoot: string): Plugin {
  let base = "/";
  let started: Promise<string> | null = null;
  let child: ChildProcess | null = null;
  let workdir: string | null = null;

  const stop = () => {
    child?.kill();
    child = null;
    if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
    workdir = null;
  };

  // Start lazily: most dev sessions never open a network session, and the
  // first nix-build of the PHP tools can take a while.
  const start = () => started ??= (async () => {
    const php = await findPhp(repoRoot);
    // The piplet rewrites its own file, so serve a private copy.
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "kandelo-signalling-"));
    const script = path.join(workdir, "piplet.php");
    fs.copyFileSync(path.join(repoRoot, "apps/signalling/piplet.php"), script);
    const port = await freePort();
    child = spawn(php, ["-S", `127.0.0.1:${port}`, script], { cwd: workdir, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", () => {});
    child.once("exit", () => { child = null; started = null; });
    await waitForPort(port, child);
    return `http://127.0.0.1:${port}/`;
  })().catch((error) => { stop(); started = null; throw error; });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const origin = await start();
      const url = new URL(req.url ?? "/", "http://dev.invalid");
      const target = new URL(url.search, origin);
      const headers: Record<string, string> = {};
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const method = req.method ?? "GET";
      const body = method === "POST" ? await readBody(req) : undefined;
      const response = await fetch(target, { method, headers, body });
      res.statusCode = response.status;
      const type = response.headers.get("content-type");
      if (type) res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "no-store");
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      const reason = error instanceof Error ? error.message : String(error);
      res.end(JSON.stringify({ error: `the development signalling server is unavailable: ${reason}` }));
    }
  };

  return {
    name: "dev-signalling-server",
    apply: "serve",
    configResolved(config) { base = config.base; },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.originalUrl ?? req.url ?? "").split("?")[0];
        if (pathname !== devSignallingPathForBase(base)) { next(); return; }
        void handle(req, res);
      });
      server.httpServer?.once("close", stop);
      process.once("exit", stop);
    },
  };
}
