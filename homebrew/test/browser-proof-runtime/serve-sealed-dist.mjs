import {
  createReadStream,
  lstatSync,
  realpathSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const options = parseArguments(process.argv.slice(2));
const rootStat = lstatSync(options.root);
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error("--root must be a regular non-symlink directory");
}
const root = realpathSync(options.root);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
  [".zst", "application/zstd"],
]);

const server = createServer((request, response) => {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const requestTarget = request.url ?? "/";
    let rawPathname;
    try {
      rawPathname = decodeURIComponent(requestTarget.split("?", 1)[0]);
    } catch {
      respondText(response, 400, "invalid URL encoding\n");
      return;
    }
    if (
      rawPathname.includes("\0") ||
      rawPathname.includes("\\") ||
      rawPathname.split("/").some((part) => part === "..")
    ) {
      respondText(response, 400, "invalid path\n");
      return;
    }

    const url = new URL(requestTarget, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    let relative = pathname.replace(/^\/+/, "");
    if (relative === "" || relative.endsWith("/")) {
      relative += "index.html";
    }
    const candidate = resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
      respondText(response, 400, "invalid path\n");
      return;
    }

    let stat;
    try {
      const canonicalCandidate = realpathSync(candidate);
      if (
        canonicalCandidate !== candidate ||
        (
          canonicalCandidate !== root &&
          !canonicalCandidate.startsWith(`${root}${sep}`)
        )
      ) {
        respondText(response, 404, "not found\n");
        return;
      }
      stat = lstatSync(candidate);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        respondText(response, 404, "not found\n");
        return;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      respondText(response, 404, "not found\n");
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": stat.size,
      "Content-Type":
        contentTypes.get(extname(candidate).toLowerCase()) ??
        "application/octet-stream",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Service-Worker-Allowed": "/",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(candidate).pipe(response);
  } catch (error) {
    respondText(
      response,
      500,
      `sealed-dist server failed: ${String(error)}\n`,
    );
  }
});

server.listen(options.port, "127.0.0.1");

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}

function parseArguments(arguments_) {
  let root;
  let port;
  while (arguments_.length > 0) {
    const flag = arguments_.shift();
    const value = arguments_.shift();
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--root") root = value;
    else if (flag === "--port") port = Number(value);
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (root === undefined) throw new Error("--root is required");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be a valid TCP port");
  }
  return { root, port };
}

function respondText(response, status, text) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  response.end(text);
}
