import { createServer, type Server } from "node:http";
import { lstat, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type ScopedDeployment = "a" | "candidate-b";

export interface ScopedStaticRequest {
  deployment: ScopedDeployment | null;
  file: string | null;
  method: string;
  pathname: string;
  search: string;
  status: number;
}

export interface ScopedStaticServer {
  readonly origin: string;
  /**
   * The deployments' guest preview origin. It serves `<root>-preview` (the
   * bundle `vite build` writes beside each app build when
   * `KANDELO_PREVIEW_ORIGIN` is set) at the same scope, and redirects a
   * top-level `computer/*` visit to the app's viewer shell.
   */
  readonly previewOrigin: string;
  clearRequests(): void;
  close(): Promise<void>;
  replaceRoot(deployment: ScopedDeployment, root: string): Promise<void>;
  requests(): readonly ScopedStaticRequest[];
  setSymlinkRejection(enabled: boolean): void;
}

export async function startScopedStaticServer(options: {
  aRoot: string;
  candidateBRoot: string;
}): Promise<ScopedStaticServer> {
  const roots: Record<ScopedDeployment, string> = {
    a: await exactRoot(options.aRoot),
    "candidate-b": await exactRoot(options.candidateBRoot),
  };
  const requests: ScopedStaticRequest[] = [];
  let rejectSymlinks = true;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const record: ScopedStaticRequest = {
      deployment: deploymentFor(url.pathname),
      file: null,
      method: request.method ?? "GET",
      pathname: url.pathname,
      search: url.search,
      status: 500,
    };
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return send(response, record, 405);
      }
      if (record.deployment === null) return send(response, record, 404);
      const file = await requestedFile(
        roots[record.deployment],
        url.pathname,
        record.deployment,
        rejectSymlinks,
      );
      record.file = relative(roots[record.deployment], file).split(sep).join("/");
      const metadata = await stat(file);
      if (!metadata.isFile()) return send(response, record, 404);
      record.status = 200;
      response.writeHead(200, headers(file, metadata.size));
      if (request.method === "HEAD") response.end();
      else response.end(await readFile(file));
    } catch (error) {
      if (error instanceof RequestPathError) return send(response, record, 404);
      return send(response, record, 500);
    } finally {
      requests.push(record);
    }
  });
  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  const preview = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const deployment = deploymentFor(url.pathname);
    for (const [name, value] of Object.entries(PREVIEW_HEADERS)) response.setHeader(name, value);
    try {
      if (deployment === null) throw new RequestPathError();
      const relative = url.pathname.slice(`/${deployment}/`.length);
      if (relative === "computer" || relative.startsWith("computer/")) {
        response.writeHead(302, { Location: `${origin}${url.pathname}${url.search}` });
        response.end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") throw new RequestPathError();
      const file = await requestedFile(`${roots[deployment]}-preview`, url.pathname, deployment, true);
      const metadata = await stat(file);
      if (!metadata.isFile()) throw new RequestPathError();
      response.writeHead(200, { "Content-Type": contentType(file), "Content-Length": String(metadata.size) });
      if (request.method === "HEAD") response.end();
      else response.end(await readFile(file));
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  const previewPort = await listen(preview);
  return {
    origin,
    previewOrigin: `http://127.0.0.1:${previewPort}`,
    clearRequests: () => { requests.length = 0; },
    close: async () => { await Promise.all([close(server), close(preview)]); },
    replaceRoot: (deployment, root) => replaceRoot(roots, deployment, root),
    requests: () => requests.slice(),
    setSymlinkRejection: (enabled) => { rejectSymlinks = enabled; },
  };
}

const PREVIEW_HEADERS = {
  "Cache-Control": "no-store",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Origin-Agent-Cluster": "?1",
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("scoped server has no TCP address");
  return address.port;
}

async function replaceRoot(roots: Record<ScopedDeployment, string>, deployment: ScopedDeployment, root: string): Promise<void> {
  roots[deployment] = await exactRoot(root);
}

async function exactRoot(root: string): Promise<string> {
  if (!isAbsolute(root) || resolve(root) !== root) throw new Error("scoped deployment root must be absolute and normalized");
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("scoped deployment root must be a direct directory");
  return root;
}

function deploymentFor(pathname: string): ScopedDeployment | null {
  if (pathname === "/a/" || pathname.startsWith("/a/")) return "a";
  if (pathname === "/candidate-b/" || pathname.startsWith("/candidate-b/")) return "candidate-b";
  return null;
}

async function requestedFile(
  root: string,
  pathname: string,
  deployment: ScopedDeployment,
  rejectSymlinks: boolean,
): Promise<string> {
  const prefix = `/${deployment}/`;
  if (!pathname.startsWith(prefix)) throw new RequestPathError();
  const encoded = pathname.slice(prefix.length);
  const segments = encoded === "" ? ["index.html"] : encoded.split("/").map(decodeSegment);
  const file = resolve(root, ...segments);
  if (!within(root, file)) throw new RequestPathError();
  if (rejectSymlinks) {
    let current = root;
    for (const segment of segments) {
      current = resolve(current, segment);
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new RequestPathError();
    }
  }
  return file;
}

function decodeSegment(segment: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(segment); } catch { throw new RequestPathError(); }
  if (decoded === "" || decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
    throw new RequestPathError();
  }
  return decoded;
}

function within(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path);
}

function headers(file: string, bytes: number): Record<string, string> {
  return {
    "Cache-Control": file.endsWith("/service-worker.js") ? "no-store" : "public, max-age=0",
    "Content-Length": String(bytes),
    "Content-Type": contentType(file),
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

function contentType(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function send(response: import("node:http").ServerResponse, record: ScopedStaticRequest, status: number): void {
  record.status = status;
  response.writeHead(status, {
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  response.end();
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

class RequestPathError extends Error {}
