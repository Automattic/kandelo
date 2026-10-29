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
 */
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

// Keep equal to PREVIEW_PROTOCOL_VERSION in lib/preview/protocol.ts
// (preview-bridge.test.ts checks).
export const PREVIEW_PROTOCOL_VERSION = 3;

/** Injected into the relay and the preview service worker. */
export interface PreviewOriginBundleConfig {
  protocolVersion: number;
  /** Exact Kandelo app origins the relay accepts; the first is canonical. */
  kandeloOrigins: string[];
  /** Optional anchored pattern for Spacefast version hosts of the app. */
  kandeloOriginPattern: string | null;
}

/** What the app is told (see lib/preview/config.ts). */
export type AppPreviewOriginConfig =
  | { kind: "origin"; origin: string }
  | { kind: "port-offset"; offset: number }
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

export function previewBundleConfig(appOrigin: string): PreviewOriginBundleConfig {
  const origin = exactOrigin(appOrigin, "KANDELO_APP_ORIGIN");
  return {
    protocolVersion: PREVIEW_PROTOCOL_VERSION,
    kandeloOrigins: [origin],
    kandeloOriginPattern: spacefastVersionHostPattern(origin),
  };
}

/** The bundle's files with `config` injected, keyed by scope-relative path. */
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

/** Headers for every preview-origin response. */
export const PREVIEW_ORIGIN_HEADERS: Readonly<Record<string, string>> = {
  // The Kandelo page is cross-origin isolated: a frame it embeds must opt
  // into COEP and allow cross-origin embedding. No frame-ancestors or
  // X-Frame-Options here: the relay and guest pages are framed by Kandelo.
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Origin-Agent-Cluster": "?1",
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
  if (configured === "off") return null;
  if (configured) return { kind: "origin", origin: exactOrigin(configured, "KANDELO_PREVIEW_ORIGIN") };
  return command === "serve" ? { kind: "port-offset", offset: 1 } : null;
}

const VIEWER_HTML_RELATIVE = "pages/kandelo/viewer.html";

/**
 * Vite plugin: the preview origin for `vite` and `vite preview`, the viewer
 * shell for `<base>computer/*` documents on the app origin, and the preview
 * bundle for production builds.
 */
export function previewOriginPlugin(): Plugin {
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
      const files = previewBundleFiles({
        protocolVersion: PREVIEW_PROTOCOL_VERSION,
        kandeloOrigins: appOrigins,
        kandeloOriginPattern: null,
      });
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
      const host = typeof address.address === "string" && address.address !== "::" &&
          address.address !== "0.0.0.0"
        ? address.address
        : undefined;
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
      if ((!previewOrigin || previewOrigin === "off") && !appOrigin) return;
      if (!previewOrigin || !appOrigin) {
        throw new Error(
          "A production preview origin needs both KANDELO_PREVIEW_ORIGIN and KANDELO_APP_ORIGIN",
        );
      }
      if (exactOrigin(previewOrigin, "KANDELO_PREVIEW_ORIGIN") === exactOrigin(appOrigin, "KANDELO_APP_ORIGIN")) {
        throw new Error("KANDELO_PREVIEW_ORIGIN must differ from KANDELO_APP_ORIGIN");
      }
      const target = process.env.KANDELO_PREVIEW_OUT_DIR?.trim() || `${outDir}-preview`;
      for (const [relative, text] of Object.entries(previewBundleFiles(previewBundleConfig(appOrigin)))) {
        const file = path.join(target, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
      }
    },
  };
}
