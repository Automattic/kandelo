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
// Only the resolver chooses the file, and only its exact answer is approved
// for Vite's `/@fs/` transport, which keeps the existing exact-file guard on
// the package cache. The image records each body's size and SHA-256, and the
// kernel checks both on fetch.
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

export interface DevLazyAssetOptions {
  /**
   * The dev-server path that serves the package-mirror path `relPath`, or
   * `null` when nothing published it. Under SourceOnly this is the pinned
   * snapshot store's path; otherwise the resolver's exact file, approved for
   * Vite's `/@fs/` transport.
   */
  servePath(relPath: string, base: string): string | null;
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
        let served: string | null;
        try {
          served = options.servePath(classified.relPath, base);
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
        // Later middleware (Vite's `/@fs/` serving, or the SourceOnly store)
        // answers the rewritten path.
        request.url = served;
        next();
      });
    },
  };
}

export interface BatchedFsServePathOptions {
  /** The published SourceOnly projection authority; its identity (size and
   *  modification time) keys the batch. */
  projectionPath: string;
  /** Every package-mirror path the projection publishes. */
  listMembers(projectionPath: string): string[];
  /** Resolve many paths at once, inside one program-index freshness check. */
  resolveBatch(relPaths: readonly string[]): Array<string | null>;
  /** Resolve one path the projection does not list (a fetched mirror). */
  resolveOne(relPath: string): string | null;
  /** Approve one exact file for `/@fs/`; returns its canonical path. */
  approve(file: string): string;
  /** The projection's identity, or null when it is absent. */
  identity(projectionPath: string): string | null;
}

/**
 * `servePath` for the ordinary resolver: its exact file through `/@fs/`.
 *
 * Each resolver call checks the program index first, which takes seconds and
 * runs synchronously; resolving per request would block the dev server and
 * serialize a desktop's dozens of lazy fetches behind it. So every member the
 * published projection lists is resolved in one batch, the first time any is
 * requested and again whenever the projection changes. A path the projection
 * does not list falls back to a single resolution, remembered like the rest
 * (a miss included) until the projection changes.
 */
export function batchedFsServePath(
  options: BatchedFsServePathOptions,
): DevLazyAssetOptions["servePath"] {
  let batchIdentity: string | null = null;
  let resolved = new Map<string, string | null>();
  return (relPath, base) => {
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
    const canonical = options.approve(file);
    // Vite decodes the `/@fs/` path with decodeURI, so encode it the same
    // way: a space or `%` in the checkout path must round-trip.
    return `${base}@fs${encodeURI(canonical.startsWith("/") ? canonical : `/${canonical}`)}`;
  };
}
