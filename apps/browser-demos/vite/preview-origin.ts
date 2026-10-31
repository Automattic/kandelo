/**
 * The guest web preview origin: build outputs and the development listener.
 *
 * Guest pages are served from an origin of their own so their scripts cannot
 * reach the Kandelo page (docs/browser-support.md, "Guest web previews run on
 * their own origin"). That origin serves only static files:
 * - `<scope>preview-service-worker.js`, which forwards guest requests to the
 *   owning Kandelo tab;
 * - `<scope>__kandelo_preview/relay.html` and `relay.js`, the hidden frame
 *   that hands the worker its bridge ports;
 * - for `<scope>computer/*` reaching the network (a top-level preview tab the
 *   worker does not control), a redirect to Kandelo's viewer shell.
 * No guest bytes ever come from the network on either origin.
 *
 * Origins:
 * - `vite` / `vite preview`: a second listener on the app's host at the app's
 *   port + 1 (or `KANDELO_PREVIEW_ORIGIN`), same site as the app.
 * - Production builds: `KANDELO_PREVIEW_ORIGIN` (where the preview bundle will
 *   be served) and `KANDELO_APP_ORIGIN` (the only origin its relay accepts)
 *   together; the bundle is written beside the app output. Without them the
 *   app has no preview origin and refuses to open web previews.
 *
 * Hosts (`KANDELO_PREVIEW_HOST`, see `PREVIEW_HOST_LAYOUTS`):
 * - `static` (default): the files above, for a host that adds
 *   `PREVIEW_ORIGIN_HEADERS` to every response (Vite's listener, a Spacefast
 *   Space with the `_headers` from `spacefastPreviewSiteFiles`).
 * - `php`: PHP scripts that send those headers themselves, for a host that
 *   runs PHP but may not let a site set headers on static files (WP Cloud).
 *   Their URLs end in `.php`, so the app is built with the same host and
 *   asks for `relay.php`. `vite` runs this bundle under `php -S` itself.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

// Keep equal to PREVIEW_PROTOCOL_VERSION in lib/preview/protocol.ts
// (preview-bridge.test.ts checks).
export const PREVIEW_PROTOCOL_VERSION = 3;

/** How the preview origin's server delivers the bundle and its headers. */
export type PreviewHost = "static" | "php";

/**
 * Where the relay page and the preview service worker live, relative to the
 * deployment scope, for each host. The relay stays one directory below the
 * scope (it finds the scope as `../`). The `static` paths are the ones
 * `lib/preview/protocol.ts` names (preview-bridge.test.ts checks).
 */
export const PREVIEW_HOST_LAYOUTS: Readonly<Record<PreviewHost, {
  relayPath: string;
  workerFile: string;
}>> = {
  static: { relayPath: "__kandelo_preview/relay.html", workerFile: "preview-service-worker.js" },
  php: { relayPath: "__kandelo_preview/relay.php", workerFile: "preview-service-worker.php" },
};

/** `KANDELO_PREVIEW_HOST`, `static` when unset. */
export function previewHostFromEnvironment(): PreviewHost {
  const value = process.env.KANDELO_PREVIEW_HOST?.trim() || "static";
  if (value !== "static" && value !== "php") {
    throw new Error(`KANDELO_PREVIEW_HOST must be "static" or "php", not ${JSON.stringify(value)}`);
  }
  return value;
}

/** Injected into the relay and the preview service worker. */
export interface PreviewOriginBundleConfig {
  protocolVersion: number;
  /** Exact Kandelo app origins the relay accepts; the first is canonical. */
  kandeloOrigins: string[];
  /** Optional anchored pattern for Spacefast version hosts of the app. */
  kandeloOriginPattern: string | null;
  /** This host's relay page, relative to the scope. */
  relayPath: string;
  /** This host's preview service worker script, in the scope directory. */
  workerFile: string;
}

/** What the app is told (see lib/preview/config.ts). */
export type AppPreviewOriginConfig =
  | { kind: "origin"; origin: string; relayPath: string }
  | { kind: "port-offset"; offset: number; relayPath: string }
  | null;

const SOURCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../preview-origin");
const CONFIG_PLACEHOLDER = '"__KANDELO_PREVIEW_ORIGIN_CONFIG__"';

/** Paths relative to the deployment scope. */
export const PREVIEW_BUNDLE_FILES = {
  "preview-service-worker.js": "preview-service-worker.js",
  "__kandelo_preview/relay.html": "relay.html",
  "__kandelo_preview/relay.js": "relay.js",
} as const;

/** Exact `scheme://host[:port]` with nothing else, or an error. */
export function exactOrigin(value: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an origin such as https://preview.example.com`);
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.origin !== value || parsed.username || parsed.password
  ) {
    throw new Error(`${name} must be exactly an origin, without a path or trailing slash: ${value}`);
  }
  return parsed.origin;
}

/**
 * Spacefast serves a Space's earlier versions at `<label>--v<n>.<domain>`.
 * Slugs cannot contain `--`, so only that Space can own those hosts, and the
 * relay may accept them for an app published there.
 */
export function spacefastVersionHostPattern(appOrigin: string): string | null {
  const url = new URL(appOrigin);
  const match = /^([a-z0-9-]+)\.(space\.fast|view\.fast)$/.exec(url.hostname);
  if (url.protocol !== "https:" || !match || match[1]!.includes("--")) return null;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^https://${escape(match[1]!)}--v[0-9]+\\.${escape(match[2]!)}$`;
}

export function previewBundleConfig(
  appOrigin: string,
  host: PreviewHost = "static",
): PreviewOriginBundleConfig {
  const origin = exactOrigin(appOrigin, "KANDELO_APP_ORIGIN");
  return {
    protocolVersion: PREVIEW_PROTOCOL_VERSION,
    kandeloOrigins: [origin],
    kandeloOriginPattern: spacefastVersionHostPattern(origin),
    ...PREVIEW_HOST_LAYOUTS[host],
  };
}

/**
 * The `static` bundle's files with `config` injected, keyed by
 * scope-relative path. (`phpPreviewSiteFiles` repackages them.)
 */
export function previewBundleFiles(config: PreviewOriginBundleConfig): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [relative, source] of Object.entries(PREVIEW_BUNDLE_FILES)) {
    const text = fs.readFileSync(path.join(SOURCE_DIR, source), "utf8");
    files[relative] = source.endsWith(".js") ? injectConfig(text, config) : text;
  }
  return files;
}

function injectConfig(text: string, config: PreviewOriginBundleConfig): string {
  if (!text.includes(CONFIG_PLACEHOLDER)) {
    throw new Error("preview-origin script is missing its configuration placeholder");
  }
  return text.replace(CONFIG_PLACEHOLDER, JSON.stringify(config));
}

/**
 * Headers for every preview-origin response, on every host. The relay's
 * first load comes before any preview service worker exists, so the server
 * itself must send them.
 */
export const PREVIEW_ORIGIN_HEADERS: Readonly<Record<string, string>> = {
  // The Kandelo page is cross-origin isolated: a frame it embeds must opt
  // into COEP and allow cross-origin embedding. No frame-ancestors or
  // X-Frame-Options here: the relay and guest pages are framed by Kandelo.
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Origin-Agent-Cluster": "?1",
  // Every file is served with its real type; never guess one.
  "X-Content-Type-Options": "nosniff",
  // A deploy must reach open tabs: the relay and worker carry the protocol
  // version and the app origin, which must match the app's.
  "Cache-Control": "no-store",
};

function contentType(file: string): string {
  return file.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8";
}

/**
 * Answer one preview-origin request: a bundle file, the viewer-shell
 * redirect for `computer/*`, or 404. Shared by the development listener and
 * the static-server test fixture.
 */
export function servePreviewOriginRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    scope: string;
    files: Record<string, string>;
    /** The Kandelo origin to send a top-level `computer/*` visit to. */
    appOriginFor: (hostHeader: string | undefined) => string;
  },
): void {
  const url = new URL(request.url ?? "/", "http://preview.invalid");
  const method = request.method ?? "GET";
  for (const [name, value] of Object.entries(PREVIEW_ORIGIN_HEADERS)) response.setHeader(name, value);
  const relative = url.pathname.startsWith(options.scope) ? url.pathname.slice(options.scope.length) : null;
  if (relative !== null && Object.hasOwn(options.files, relative)) {
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const body = options.files[relative]!;
    response.writeHead(200, {
      "Content-Type": contentType(relative),
      "Content-Length": Buffer.byteLength(body),
    });
    response.end(method === "HEAD" ? undefined : body);
    return;
  }
  if (relative === "computer" || relative?.startsWith("computer/")) {
    const viewer = `${options.appOriginFor(request.headers.host)}${url.pathname}${url.search}`;
    if (method === "GET" || method === "HEAD") {
      response.writeHead(302, { Location: viewer });
      response.end();
      return;
    }
    response.writeHead(405, { "Content-Type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><title>Open this page in Kandelo</title>" +
        "<p>A form was submitted to a Kandelo computer outside Kandelo, and it cannot be replayed.</p>",
    );
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not a Kandelo preview-origin file\n");
}

/** Spacefast `_headers` and `_redirects` for a preview Space. */
export function spacefastPreviewSiteFiles(scope: string, appOrigin: string): Record<string, string> {
  const origin = exactOrigin(appOrigin, "app origin");
  return {
    _headers: `${scope}*\n` +
      Object.entries(PREVIEW_ORIGIN_HEADERS)
        .map(([name, value]) => `  ${name}: ${value}\n`)
        .join(""),
    _redirects: `${scope}computer/*  ${origin}${scope}computer/:splat  302\n`,
  };
}

function phpString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * The start of every PHP entry point: the shared headers, sent by PHP so
 * they do not depend on the host's static-file configuration.
 */
function phpPreamble(purpose: string): string {
  const fields = Object.entries(PREVIEW_ORIGIN_HEADERS)
    .map(([name, value]) => `    ${phpString(`${name}: ${value}`)},\n`)
    .join("");
  return `<?php
// Kandelo guest-preview origin: ${purpose}
// Generated by apps/browser-demos/vite/preview-origin.ts for
// \`./run.sh build-browser --preview-host php\`; rebuild it, do not edit it.
// PHP sends every response field itself, so this works on a host that
// cannot set headers on static files. See docs/browser-support.md,
// "Guest web previews run on their own origin".
header_remove('X-Powered-By');
foreach ([
${fields}] as $field) {
    header($field);
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
`;
}

/**
 * One file's bytes behind the preamble. They follow `__halt_compiler()`,
 * so PHP never parses them and serves them exactly.
 */
function phpFileEntry(purpose: string, contentType: string, body: string): string {
  return `${phpPreamble(purpose)}if ($method !== 'GET' && $method !== 'HEAD') {
    http_response_code(405);
    header('Allow: GET, HEAD');
    exit;
}
header(${phpString(`Content-Type: ${contentType}`)});
if ($method === 'GET') {
    echo file_get_contents(__FILE__, false, null, __COMPILER_HALT_OFFSET__);
}
exit;
__halt_compiler();${body}`;
}

/** relay.html with relay.js inlined: one PHP-served document. */
function inlineRelayDocument(html: string, script: string): string {
  const tag = '<script src="relay.js"></script>';
  if (html.split(tag).length !== 2) throw new Error("relay.html must load relay.js exactly once");
  if (/<\/script|<!--/i.test(script)) throw new Error("relay.js cannot be inlined into relay.html");
  return html.replace(tag, () => `<script>\n${script}</script>`);
}

/**
 * The preview bundle for a PHP host such as WP Cloud: the same relay and
 * worker bytes behind PHP entry points (paths from
 * `PREVIEW_HOST_LAYOUTS.php`), plus `index.php`, which sends a top-level
 * visit to `<scope>computer/*` to the viewer shell on the canonical app
 * origin. `index.php` sees those visits only where the host routes requests
 * for missing paths to it (WordPress-style hosting, `php -S`); elsewhere
 * they get the host's own 404.
 */
export function phpPreviewSiteFiles(
  config: PreviewOriginBundleConfig,
  scope: string,
): Record<string, string> {
  const layout = PREVIEW_HOST_LAYOUTS.php;
  if (config.relayPath !== layout.relayPath || config.workerFile !== layout.workerFile) {
    throw new Error("The PHP preview bundle needs a configuration built for the php host");
  }
  if (!/^\/(?:.*\/)?$/.test(scope)) throw new Error(`The scope must start and end with "/": ${scope}`);
  const app = exactOrigin(config.kandeloOrigins[0] ?? "", "app origin");
  const files = previewBundleFiles(config);
  const relay = inlineRelayDocument(files["__kandelo_preview/relay.html"]!, files["__kandelo_preview/relay.js"]!);
  return {
    [layout.workerFile]: phpFileEntry(
      "the preview service worker.",
      "text/javascript; charset=utf-8",
      files["preview-service-worker.js"]!,
    ),
    [layout.relayPath]: phpFileEntry(
      "the relay page each Kandelo tab frames.",
      "text/html; charset=utf-8",
      relay,
    ),
    "index.php": `${phpPreamble("the viewer-shell redirect for computer/* and 404s.")}$scope = ${phpString(scope)};
$app = ${phpString(app)};
$uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
$path = parse_url($uri, PHP_URL_PATH);
$query = parse_url($uri, PHP_URL_QUERY);
$path = is_string($path) ? $path : '';
$machines = $scope . 'computer';
if ($path === $machines || strncmp($path, $machines . '/', strlen($machines) + 1) === 0) {
    if ($method === 'GET' || $method === 'HEAD') {
        header('Location: ' . $app . $path . (is_string($query) ? '?' . $query : ''), true, 302);
        exit;
    }
    http_response_code(405);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><title>Open this page in Kandelo</title>',
        '<p>A form was submitted to a Kandelo computer outside Kandelo, and it cannot be replayed.</p>';
    exit;
}
http_response_code(404);
header('Content-Type: text/plain; charset=utf-8');
echo "Not a Kandelo preview-origin file\\n";
`,
  };
}

/** Write `files` (scope-relative paths) under `directory`. */
function writeFiles(directory: string, files: Record<string, string>): void {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

function isLoopbackHttpOrigin(origin: string): boolean {
  const url = new URL(origin);
  return url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
}

/**
 * The app-facing config for this command. `KANDELO_PREVIEW_ORIGIN=off` runs
 * a server with no preview origin (its app refuses web previews): for a
 * second server on an ephemeral port, such as a spec's own Vite instance,
 * whose port + 1 may belong to another server.
 */
export function appPreviewOriginConfig(command: "serve" | "build"): AppPreviewOriginConfig {
  const configured = process.env.KANDELO_PREVIEW_ORIGIN?.trim();
  const { relayPath } = PREVIEW_HOST_LAYOUTS[previewHostFromEnvironment()];
  if (configured === "off") return null;
  if (configured) {
    return { kind: "origin", origin: exactOrigin(configured, "KANDELO_PREVIEW_ORIGIN"), relayPath };
  }
  return command === "serve" ? { kind: "port-offset", offset: 1, relayPath } : null;
}


const VIEWER_HTML_RELATIVE = "pages/kandelo/viewer.html";

/**
 * When the `php -S` serving each preview port last exited. Process-wide, not
 * per plugin instance: Vite loads a fresh copy of this module for every
 * restart, and the outgoing and incoming servers share the port.
 */
const phpPreviewExits: Map<number, Promise<void>> = ((globalThis as {
  __kandeloPhpPreviewExits?: Map<number, Promise<void>>;
}).__kandeloPhpPreviewExits ??= new Map());

/**
 * Vite plugin: the preview origin for `vite` and `vite preview`, the viewer
 * shell for `<base>computer/*` documents on the app origin, and the preview
 * bundle for production builds.
 */
export function previewOriginPlugin(options: {
  /** The PHP that runs a php-host bundle under `vite` (KANDELO_PREVIEW_HOST=php). */
  findPhp: () => Promise<string>;
}): Plugin {
  let base = "/";
  let root = process.cwd();
  let outDir = "dist";
  let command: "serve" | "build" = "serve";

  function startListener(
    httpServer: http.Server | null | undefined,
    logger: { info(message: string): void; error(message: string): void },
  ): void {
    if (!httpServer) return;
    // Read the configuration now, with the environment the server was
    // created under, not whatever it holds when the socket starts listening.
    const configured = appPreviewOriginConfig("serve");
    const previewHost = previewHostFromEnvironment();
    httpServer.once("listening", () => {
      const address = httpServer.address() as AddressInfo | null;
      if (!address || typeof address === "string") return;
      const appPort = address.port;
      if (configured === null) {
        logger.info("Guest previews: no preview origin (KANDELO_PREVIEW_ORIGIN=off)");
        return;
      }
      let previewPort: number;
      if (configured.kind === "origin") {
        if (!isLoopbackHttpOrigin(configured.origin)) {
          logger.info(`Guest previews: using the external preview origin ${configured.origin}`);
          return;
        }
        previewPort = Number(new URL(configured.origin).port || 80);
      } else {
        previewPort = appPort + 1;
      }
      const appOrigins = [`http://127.0.0.1:${appPort}`, `http://localhost:${appPort}`];
      const bundleConfig: PreviewOriginBundleConfig = {
        protocolVersion: PREVIEW_PROTOCOL_VERSION,
        kandeloOrigins: appOrigins,
        kandeloOriginPattern: null,
        ...PREVIEW_HOST_LAYOUTS[previewHost],
      };
      const host = typeof address.address === "string" && address.address !== "::" &&
          address.address !== "0.0.0.0"
        ? address.address
        : undefined;
      if (previewHost === "php") {
        startPhpListener(httpServer, logger, bundleConfig, host, previewPort);
        return;
      }
      const files = previewBundleFiles(bundleConfig);
      const listener = http.createServer((request, response) => {
        servePreviewOriginRequest(request, response, {
          scope: base,
          files,
          appOriginFor: (host) => host?.startsWith("localhost:") ? appOrigins[1]! : appOrigins[0]!,
        });
      });
      listener.on("error", (error) => {
        // Truthful failure: previews then report that the preview origin did
        // not answer. Nothing falls back to serving guests on the app origin.
        logger.error(
          `Guest previews are unavailable: the preview origin could not listen on port ${previewPort}: ${error.message}`,
        );
      });
      listener.listen(previewPort, host, () => {
        logger.info(`Guest preview origin: http://${host ?? "localhost"}:${previewPort}${base}`);
      });
      httpServer.once("close", () => {
        // Drop kept-alive connections too: after a restart they would keep
        // answering with the outgoing server's bundle.
        listener.close();
        listener.closeAllConnections();
      });
    });
  }

  /**
   * The PHP bundle under PHP's built-in server, which routes a missing path
   * to `index.php` as WordPress-style hosting does.
   */
  function startPhpListener(
    httpServer: http.Server,
    logger: { info(message: string): void; error(message: string): void },
    bundleConfig: PreviewOriginBundleConfig,
    host: string | undefined,
    previewPort: number,
  ): void {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kandelo-preview-php-"));
    writeFiles(path.join(directory, base), phpPreviewSiteFiles(bundleConfig, base));
    let closed = false;
    let stop = () => {};
    // A restart stops the outgoing server's `php -S` and starts this one on
    // the same port. Killing a process does not free its port at once, so
    // wait for the previous one to exit rather than race it for the port.
    const previousExit = phpPreviewExits.get(previewPort) ?? Promise.resolve();
    let markExited!: () => void;
    const exited = new Promise<void>((resolve) => { markExited = resolve; });
    phpPreviewExits.set(previewPort, exited);
    httpServer.once("close", () => {
      closed = true;
      stop();
      fs.rmSync(directory, { recursive: true, force: true });
    });
    Promise.all([options.findPhp(), previousExit]).then(([php]) => {
      if (closed) {
        markExited();
        return;
      }
      const child = spawn(php, ["-S", `${host ?? "0.0.0.0"}:${previewPort}`, "-t", directory], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.once("error", (error) => {
        markExited();
        logger.error(`Guest previews are unavailable: could not run ${php}: ${error.message}`);
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.once("exit", (code, signal) => {
        markExited();
        if (closed) return;
        logger.error(
          `Guest previews are unavailable: php -S on port ${previewPort} exited (${code ?? signal}): ${stderr.trim()}`,
        );
      });
      stop = () => child.kill();
      logger.info(`Guest preview origin (PHP bundle, ${php} -S): http://${host ?? "localhost"}:${previewPort}${base}`);
    }, (error: Error) => {
      markExited();
      logger.error(`Guest previews are unavailable: no PHP to serve the php preview bundle: ${error.message}`);
    });
  }

  function attachViewerShell(
    middlewares: ViteDevServer["middlewares"] | PreviewServer["middlewares"],
    html: (url: string) => Promise<string | null>,
  ): void {
    middlewares.use((request, response, next) => {
      const url = new URL(request.url ?? "/", "http://app.invalid");
      const relative = url.pathname.startsWith(base) ? url.pathname.slice(base.length) : null;
      if (relative !== "computer" && !relative?.startsWith("computer/")) {
        next();
        return;
      }
      const method = request.method ?? "GET";
      const destination = request.headers["sec-fetch-dest"];
      const wantsDocument = destination === "document" ||
        (destination === undefined && String(request.headers.accept ?? "").includes("text/html"));
      if ((method !== "GET" && method !== "HEAD") || !wantsDocument) {
        // Guest pages never come from Kandelo's origin.
        response.statusCode = 404;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("Guest web pages are served from this deployment's preview origin.\n");
        return;
      }
      html(request.url ?? "/").then((text) => {
        if (text === null) {
          next();
          return;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(method === "HEAD" ? undefined : text);
      }, next);
    });
  }

  return {
    name: "kandelo-preview-origin",
    config(_config, env) {
      command = env.command;
      const interceptor = fs.readFileSync(
        path.resolve(SOURCE_DIR, "../public/blob-iframe-interceptor.js"),
        "utf8",
      );
      return {
        define: {
          __KANDELO_PREVIEW_ORIGIN__: JSON.stringify(appPreviewOriginConfig(env.command)),
          __KANDELO_BLOB_IFRAME_INTERCEPTOR__: JSON.stringify(interceptor),
        },
      };
    },
    configResolved(config) {
      base = config.base;
      root = config.root;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      startListener(server.httpServer as http.Server | null, server.config.logger);
      const viewerPath = path.resolve(root, VIEWER_HTML_RELATIVE);
      attachViewerShell(server.middlewares, async (url) =>
        server.transformIndexHtml(
          `${base}${VIEWER_HTML_RELATIVE}`,
          await fs.promises.readFile(viewerPath, "utf8"),
          url,
        ));
    },
    configurePreviewServer(server) {
      startListener(server.httpServer as http.Server | null, server.config.logger);
      attachViewerShell(server.middlewares, async () => {
        try {
          return await fs.promises.readFile(path.join(outDir, VIEWER_HTML_RELATIVE), "utf8");
        } catch {
          return null;
        }
      });
    },
    writeBundle() {
      if (command !== "build") return;
      const previewOrigin = process.env.KANDELO_PREVIEW_ORIGIN?.trim();
      const appOrigin = process.env.KANDELO_APP_ORIGIN?.trim();
      const previewHost = previewHostFromEnvironment();
      if ((!previewOrigin || previewOrigin === "off") && !appOrigin) {
        if (previewHost !== "static") {
          throw new Error(`KANDELO_PREVIEW_HOST=${previewHost} needs KANDELO_PREVIEW_ORIGIN and KANDELO_APP_ORIGIN`);
        }
        return;
      }
      if (!previewOrigin || !appOrigin) {
        throw new Error(
          "A production preview origin needs both KANDELO_PREVIEW_ORIGIN and KANDELO_APP_ORIGIN",
        );
      }
      if (exactOrigin(previewOrigin, "KANDELO_PREVIEW_ORIGIN") === exactOrigin(appOrigin, "KANDELO_APP_ORIGIN")) {
        throw new Error("KANDELO_PREVIEW_ORIGIN must differ from KANDELO_APP_ORIGIN");
      }
      const target = process.env.KANDELO_PREVIEW_OUT_DIR?.trim() || `${outDir}-preview`;
      const bundleConfig = previewBundleConfig(appOrigin, previewHost);
      writeFiles(
        target,
        previewHost === "php" ? phpPreviewSiteFiles(bundleConfig, base) : previewBundleFiles(bundleConfig),
      );
    },
  };
}
