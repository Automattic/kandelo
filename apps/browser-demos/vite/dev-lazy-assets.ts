// Serve VFS images' lazy files and lazy archives from the dev server.
//
// A product image records an address for every body it does not carry, and
// the kernel worker resolves each address to its package member under a
// lazy-asset directory (`resolveImageOwnedLazyAsset` in host/src). In
// production that directory is the deployment's asset group, which
// scripts/build-local-vfs-asset-group.ts stages from the images' own lazy
// entries. On the dev server it is this route: the member path resolves
// through the same binary resolver the Node host uses for lazy assets, so
// whatever the built images reference is served, and nothing in the browser
// app has to list it.
//
// Only the resolver chooses the file, and only its exact answer, approved by
// the existing exact-file guard on the package cache, is served. The route
// streams those bytes itself rather than handing them to Vite's `/@fs/`
// route: `/@fs/` runs a request with no file extension, or a JavaScript or
// CSS extension, through Vite's module transform, so an extensionless shell
// script member (sfwbar's `kandelo-sfwbar` wrapper, for instance) arrived as
// `text/javascript` with an inline source map appended. Lazy members are
// opaque file bodies; their bytes must reach the guest exactly as built. The
// image records each body's size and SHA-256, and the kernel checks both on
// fetch, so a transformed body fails as an I/O error in the guest.
import { createReadStream, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { validateVfsAssetGroupRelativePath } from "../../../host/src/vfs/vfs-asset-group-reference";

import { DEV_LAZY_ASSET_ROUTE } from "../lib/init/dev-lazy-asset-route";

export type DevLazyAssetRequest =
  | { kind: "not-mine" }
  | { kind: "invalid" }
  | { kind: "member"; relPath: string };

/**
 * Classify a request path. A member request names
 * `<base>@kandelo-lazy/assets/programs/...`; its `relPath` is the
 * package-mirror path (`programs/wasm32/tmux.wasm`).
 */
export function devLazyAssetRequest(
  requestUrl: string | undefined,
  base: string,
): DevLazyAssetRequest {
  if (!requestUrl) return { kind: "not-mine" };
  const prefix = `${base.endsWith("/") ? base : `${base}/`}${DEV_LAZY_ASSET_ROUTE}`;
  const pathname = new URL(requestUrl, "http://127.0.0.1").pathname;
  if (!pathname.startsWith(prefix)) return { kind: "not-mine" };
  const member = pathname.slice(prefix.length);
  if (!member.startsWith("assets/programs/")) return { kind: "invalid" };
  const relPath = member.slice("assets/".length);
  try {
    validateVfsAssetGroupRelativePath(relPath);
  } catch {
    return { kind: "invalid" };
  }
  return { kind: "member", relPath: decodeURIComponent(relPath) };
}

/** Where the bytes of one package member come from. */
export type DevLazyAssetSource =
  /** A dev-server path a later middleware answers: the SourceOnly store's
   *  pinned, content-addressed path. */
  | { kind: "path"; path: string }
  /** An approved file on disk this route streams byte-for-byte. */
  | { kind: "file"; file: string };

export interface DevLazyAssetOptions {
  /**
   * The source of the package-mirror path `relPath`, or `null` when nothing
   * published it. Under SourceOnly this is the pinned snapshot store's path;
   * otherwise the resolver's exact, approved file.
   */
  serve(relPath: string, base: string): DevLazyAssetSource | null;
}

function lazyAssetContentType(file: string): string {
  if (file.endsWith(".wasm")) return "application/wasm";
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

/** Send one approved file exactly as it is on disk. */
export function sendLazyAssetFile(
  method: string | undefined,
  file: string,
  response: ServerResponse,
): void {
  if (method !== "GET" && method !== "HEAD") {
    response.statusCode = 405;
    response.end("Method not allowed");
    return;
  }
  let size: number;
  try {
    const metadata = statSync(file);
    if (!metadata.isFile()) throw new Error(`${file} is not a regular file`);
    size = metadata.size;
  } catch (error) {
    response.statusCode = 500;
    response.end(
      `Lazy asset ${file} cannot be read: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", lazyAssetContentType(file));
  response.setHeader("Content-Length", size);
  // A local rebuild replaces the file in place; never let the page reuse a
  // body the image no longer describes.
  response.setHeader("Cache-Control", "no-store");
  if (method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", (error) => response.destroy(error));
  stream.pipe(response);
}

export function devLazyAssets(options: DevLazyAssetOptions): Plugin {
  return {
    name: "kandelo-dev-lazy-assets",
    apply: "serve",
    // Pre, and listed before the SourceOnly store (also pre), so this
    // middleware rewrites a request before the store's middleware looks for
    // the pinned path it is rewritten to.
    enforce: "pre",
    configureServer(server) {
      const base = server.config.base.endsWith("/")
        ? server.config.base
        : `${server.config.base}/`;
      server.middlewares.use((request, response, next) => {
        const classified = devLazyAssetRequest(request.url, base);
        if (classified.kind === "not-mine") {
          next();
          return;
        }
        if (classified.kind === "invalid") {
          response.statusCode = 403;
          response.end("Invalid lazy asset path");
          return;
        }
        let served: DevLazyAssetSource | null;
        try {
          served = options.serve(classified.relPath, base);
        } catch (error) {
          response.statusCode = 500;
          response.end(
            `Lazy asset ${classified.relPath} failed to resolve: ` +
              (error instanceof Error ? error.message : String(error)),
          );
          return;
        }
        if (served === null) {
          response.statusCode = 404;
          response.end(
            `Lazy asset ${classified.relPath} is not built. Run ./run.sh local-build.`,
          );
          return;
        }
        if (served.kind === "file") {
          sendLazyAssetFile(request.method, served.file, response);
          return;
        }
        // The SourceOnly store, a later middleware, answers its pinned path.
        request.url = served.path;
        next();
      });
    },
  };
}

export interface BatchedResolverFilesOptions {
  /** The published SourceOnly projection authority; its identity (size and
   *  modification time) keys the batch. */
  projectionPath: string;
  /** Every package-mirror path the projection publishes. */
  listMembers(projectionPath: string): string[];
  /** Resolve many paths at once, inside one program-index freshness check. */
  resolveBatch(relPaths: readonly string[]): Array<string | null>;
  /** Resolve one path the projection does not list (a fetched mirror). */
  resolveOne(relPath: string): string | null;
  /** Check one exact file against the package-cache guard; returns its
   *  canonical path. */
  approve(file: string): string;
  /** The projection's identity, or null when it is absent. */
  identity(projectionPath: string): string | null;
}

/**
 * `serve` for the ordinary resolver: its exact, approved file.
 *
 * Each resolver call checks the program index first, which takes seconds and
 * runs synchronously; resolving per request would block the dev server and
 * serialize a desktop's dozens of lazy fetches behind it. So every member the
 * published projection lists is resolved in one batch, the first time any is
 * requested and again whenever the projection changes. A path the projection
 * does not list falls back to a single resolution, remembered like the rest
 * (a miss included) until the projection changes.
 */
export function batchedResolverFiles(
  options: BatchedResolverFilesOptions,
): DevLazyAssetOptions["serve"] {
  let batchIdentity: string | null = null;
  let resolved = new Map<string, string | null>();
  return (relPath) => {
    const identity = options.identity(options.projectionPath);
    if (identity !== batchIdentity) {
      resolved = new Map();
      if (identity !== null) {
        const members = options.listMembers(options.projectionPath);
        const files = options.resolveBatch(members);
        members.forEach((member, index) => resolved.set(member, files[index] ?? null));
      }
      batchIdentity = identity;
    }
    if (!resolved.has(relPath)) resolved.set(relPath, options.resolveOne(relPath));
    const file = resolved.get(relPath)!;
    if (file === null) return null;
    return { kind: "file", file: options.approve(file) };
  };
}
