import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parse } from "@babel/parser";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite";
import type {
  SourceOnlyBinarySnapshot,
  SourceOnlyBinarySnapshotSession,
} from "../../host/src/binary-resolver";

const VIRTUAL_PREFIX = "\0kandelo-source-only-asset:";
const MODULE_PREFIX = "virtual:kandelo-source-only-asset:";
const PUBLIC_PREFIX = "__kandelo_source_only_assets__";

/** Bound the complete Vite snapshot set before the consumer allocates bytes. */
export const SOURCE_ONLY_VITE_RETAINED_MAX_BYTES = 1024 * 1024 * 1024;

interface RetainedSourceOnlyAsset {
  relPath: string;
  sha256: string;
  size: number;
  snapshotPath: string;
}

export interface SourceOnlyViteAssets {
  resolve(relPath: string): string;
  tryResolve(relPath: string): string | null;
  plugin(): Plugin;
  dispose(): void;
}

interface SourceOnlyViteAssetsOptions {
  maxRetainedBytes?: number;
  resolveMirrorImport?: (specifier: string, importer: string) => string | null;
  denyFallbackGlob?: (specifier: string, importer: string) => boolean;
  denyPublicPath?: (relPath: string) => boolean;
  disposeWith?: () => void;
}

export interface SourceOnlyPublicSnapshot {
  path: string;
  deniesRequestPath(relPath: string): boolean;
  dispose(): void;
}

/** Closed authored-public inputs; package members may have any suffix. */
export const SOURCE_ONLY_PUBLIC_FILE_ALLOWLIST = new Set([
  "blob-iframe-interceptor.js",
  "service-worker.js",
  "terminate-atomics-test.html",
  "terminate-atomics-worker.js",
  "trap-signal-test.html",
  "wasm-memory-reclaim-test.html",
  "wasm-memory-reclaim-worker.js",
]);

/** Snapshot only authored static web files; public binary fallbacks stay out. */
export function createSourceOnlyPublicSnapshot(
  publicRoot: string,
): SourceOnlyPublicSnapshot {
  const rootMetadata = lstatSync(publicRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`SourceOnly public root is not a real directory: ${publicRoot}`);
  }
  const privateRoot = mkdtempSync(join(tmpdir(), "kandelo-vite-public-"));
  chmodSync(privateRoot, 0o700);
  const snapshotPath = join(privateRoot, "public");
  mkdirSync(snapshotPath, { mode: 0o700 });
  const deniedRequestPaths = new Set<string>();
  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    rmSync(privateRoot, { recursive: true, force: true });
  }

  function scanDirectory(source: string, prefix: string): void {
    for (const entry of readdirSync(source, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const sourcePath = join(source, entry.name);
      const relPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const metadata = lstatSync(sourcePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`SourceOnly public input is a symlink: ${sourcePath}`);
      }
      if (metadata.isDirectory()) {
        scanDirectory(sourcePath, relPath);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error(`SourceOnly public input is not a regular file: ${sourcePath}`);
      }
      if (!SOURCE_ONLY_PUBLIC_FILE_ALLOWLIST.has(relPath)) {
        deniedRequestPaths.add(relPath);
        continue;
      }
      const destinationPath = join(snapshotPath, relPath);
      mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
      copyFileSync(sourcePath, destinationPath);
      chmodSync(destinationPath, 0o600);
    }
  }

  try {
    scanDirectory(publicRoot, "");
  } catch (error) {
    dispose();
    throw error;
  }
  process.once("exit", dispose);
  return {
    path: snapshotPath,
    deniesRequestPath(relPath) {
      return deniedRequestPaths.has(relPath.replace(/^\/+/, ""));
    },
    dispose,
  };
}

interface SyntaxNode {
  type?: string;
  start?: number | null;
  end?: number | null;
  [key: string]: unknown;
}

function stringLiteralValue(node: unknown): string | null {
  return typeof node === "object"
      && node !== null
      && (node as SyntaxNode).type === "StringLiteral"
      && typeof (node as { value?: unknown }).value === "string"
    ? (node as { value: string }).value
    : null;
}

function isSupportedUrlGlobOptions(node: unknown): boolean {
  if (
    typeof node !== "object"
    || node === null
    || (node as SyntaxNode).type !== "ObjectExpression"
  ) return false;
  const properties = (node as { properties?: unknown }).properties;
  if (!Array.isArray(properties) || properties.length !== 2) return false;
  const options = new Map<string, string>();
  for (const property of properties) {
    if (
      typeof property !== "object"
      || property === null
      || (property as SyntaxNode).type !== "ObjectProperty"
      || (property as { computed?: unknown }).computed === true
    ) return false;
    const rawKey = (property as { key?: unknown }).key;
    const key = typeof rawKey === "object"
        && rawKey !== null
        && (rawKey as SyntaxNode).type === "Identifier"
        && typeof (rawKey as { name?: unknown }).name === "string"
      ? (rawKey as { name: string }).name
      : stringLiteralValue(rawKey);
    const value = stringLiteralValue((property as { value?: unknown }).value);
    if (key === null || value === null || options.has(key)) return false;
    options.set(key, value);
  }
  return options.get("query") === "?url"
    && options.get("import") === "default";
}

function contentType(relPath: string): string {
  if (relPath.endsWith(".wasm")) return "application/wasm";
  if (relPath.endsWith(".json")) return "application/json";
  if (relPath.endsWith(".zip")) return "application/zip";
  return "application/octet-stream";
}

/**
 * Copy one pinned aggregate generation behind virtual Vite modules.
 *
 * The first resolution captures the full authored request batch through one
 * parsed aggregate session. Verified bytes move immediately into a private
 * immutable temp directory, so Vite retains neither mutable producer paths nor
 * an unbounded set of Buffers. Later undeclared requests still use the same
 * pinned session and the remaining total-byte budget.
 */
export function createSourceOnlyViteAssets(
  snapshotSession: SourceOnlyBinarySnapshotSession,
  declaredRelPaths: readonly string[],
  options: SourceOnlyViteAssetsOptions = {},
): SourceOnlyViteAssets {
  const maxRetainedBytes = options.maxRetainedBytes
    ?? SOURCE_ONLY_VITE_RETAINED_MAX_BYTES;
  if (!Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 0) {
    throw new Error(
      `SourceOnly Vite retained-byte limit must be a non-negative safe integer: ${maxRetainedBytes}`,
    );
  }
  const declared = [...new Set(declaredRelPaths)];
  const byRelPath = new Map<string, string>();
  const absentRelPaths = new Set<string>();
  const byVirtualId = new Map<string, RetainedSourceOnlyAsset>();
  const byPublicPath = new Map<string, RetainedSourceOnlyAsset>();
  let snapshotRoot: string | null = null;
  let retainedBytes = 0;
  let initialBatchCaptured = false;
  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (snapshotRoot !== null) {
      rmSync(snapshotRoot, { recursive: true, force: true });
      snapshotRoot = null;
    }
    options.disposeWith?.();
  }
  process.once("exit", dispose);

  function retainSnapshot(snapshot: SourceOnlyBinarySnapshot): void {
    if (byRelPath.has(snapshot.relPath)) return;
    const size = snapshot.bytes.byteLength;
    if (retainedBytes + size > maxRetainedBytes) {
      throw new Error(
        `SourceOnly Vite snapshot set exceeds the ${maxRetainedBytes}-byte total retained-byte limit`,
      );
    }
    const actualSha256 = createHash("sha256")
      .update(snapshot.bytes)
      .digest("hex");
    if (actualSha256 !== snapshot.sha256) {
      throw new Error(
        `SourceOnly snapshot for ${JSON.stringify(snapshot.relPath)} has sha256 ${actualSha256}, expected ${snapshot.sha256}`,
      );
    }
    snapshotRoot ??= mkdtempSync(join(tmpdir(), "kandelo-vite-source-only-"));
    chmodSync(snapshotRoot, 0o700);
    const snapshotPath = join(
      snapshotRoot,
      `${byVirtualId.size.toString().padStart(6, "0")}.snapshot`,
    );
    writeFileSync(snapshotPath, snapshot.bytes, { flag: "wx", mode: 0o400 });
    chmodSync(snapshotPath, 0o400);
    const virtualId = `${VIRTUAL_PREFIX}${encodeURIComponent(snapshot.relPath)}`;
    const asset = {
      relPath: snapshot.relPath,
      sha256: snapshot.sha256,
      size,
      snapshotPath,
    };
    retainedBytes += size;
    byRelPath.set(snapshot.relPath, virtualId);
    byVirtualId.set(virtualId, asset);
  }

  function captureBatch(relPaths: readonly string[]): void {
    if (disposed) throw new Error("SourceOnly Vite asset store is disposed");
    const unique = [...new Set(relPaths)].filter(
      (relPath) => !byRelPath.has(relPath) && !absentRelPaths.has(relPath),
    );
    if (unique.length === 0) return;
    const remaining = maxRetainedBytes - retainedBytes;
    const snapshots = snapshotSession.snapshots(unique, remaining);
    if (snapshots.length !== unique.length) {
      throw new Error("SourceOnly snapshot session returned the wrong batch size");
    }
    for (const [index, snapshot] of snapshots.entries()) {
      const requested = unique[index]!;
      if (snapshot === null) {
        absentRelPaths.add(requested);
        continue;
      }
      if (snapshot.relPath !== requested) {
        throw new Error(
          `SourceOnly snapshot returned ${JSON.stringify(snapshot.relPath)} for ${JSON.stringify(requested)}`,
        );
      }
      retainSnapshot(snapshot);
    }
  }

  function retain(relPath: string): string {
    if (!initialBatchCaptured) {
      captureBatch([...declared, relPath]);
      initialBatchCaptured = true;
    } else if (!byRelPath.has(relPath) && !absentRelPaths.has(relPath)) {
      captureBatch([relPath]);
    }
    const virtualId = byRelPath.get(relPath);
    if (virtualId === undefined) {
      throw new Error(
        `Browser binary ${relPath} is not owned by the pinned SourceOnly projection`,
      );
    }
    return virtualId;
  }

  function tryRetain(relPath: string): string | null {
    if (!initialBatchCaptured) {
      captureBatch([...declared, relPath]);
      initialBatchCaptured = true;
    } else if (!byRelPath.has(relPath) && !absentRelPaths.has(relPath)) {
      captureBatch([relPath]);
    }
    return byRelPath.get(relPath) ?? null;
  }

  function rewriteMirrorGlobs(code: string, importer: string): string | null {
    if (
      options.resolveMirrorImport === undefined
      || !code.includes("import.meta.glob")
    ) return null;
    const ast = parse(code, {
      sourceType: "unambiguous",
      sourceFilename: importer,
      plugins: ["jsx", "typescript", "importAttributes"],
    });
    const replacements: Array<{ start: number; end: number; text: string }> = [];
    const pending: unknown[] = [ast.program];
    while (pending.length > 0) {
      const candidate = pending.pop();
      if (typeof candidate !== "object" || candidate === null) continue;
      const node = candidate as SyntaxNode;
      if (node.type === "CallExpression") {
        const callee = node.callee as SyntaxNode | undefined;
        const object = callee?.object as SyntaxNode | undefined;
        const property = callee?.property as SyntaxNode | undefined;
        const meta = object?.meta as SyntaxNode | undefined;
        const metaProperty = object?.property as SyntaxNode | undefined;
        if (
          callee?.type === "MemberExpression"
          && (callee.computed as boolean | undefined) === false
          && object?.type === "MetaProperty"
          && meta?.name === "import"
          && metaProperty?.name === "meta"
          && property?.type === "Identifier"
          && property.name === "glob"
        ) {
          const args = node.arguments;
          if (
            Array.isArray(args)
            && typeof args[0] === "object"
            && args[0] !== null
            && (args[0] as SyntaxNode).type === "ArrayExpression"
          ) {
            throw new Error(
              `array-valued import.meta.glob is not admitted by the SourceOnly Vite boundary: ${importer}`,
            );
          }
          const specifier = Array.isArray(args)
            ? stringLiteralValue(args[0])
            : null;
          if (specifier !== null) {
            const relPath = options.resolveMirrorImport(specifier, importer);
            const deniedFallback = relPath === null
              && (options.denyFallbackGlob?.(specifier, importer) ?? false);
            if (relPath !== null || deniedFallback) {
              if (
                !Array.isArray(args)
                || args.length !== 2
                || !isSupportedUrlGlobOptions(args[1])
                || typeof node.start !== "number"
                || typeof node.end !== "number"
              ) {
                throw new Error(
                  `SourceOnly mirror glob must use exact lazy { query: "?url", import: "default" } options: ${specifier}`,
                );
              }
              const virtualId = relPath === null ? null : tryRetain(relPath);
              const replacement = virtualId === null
                ? "({})"
                : `({${JSON.stringify(specifier)}:()=>import(${JSON.stringify(
                  `${MODULE_PREFIX}${encodeURIComponent(relPath)}`,
                )}).then((module)=>module.default)})`;
              replacements.push({
                start: node.start,
                end: node.end,
                text: replacement,
              });
            }
          }
        }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) pending.push(...value);
        else if (typeof value === "object" && value !== null) pending.push(value);
      }
    }
    if (replacements.length === 0) return null;
    let rewritten = code;
    for (const replacement of replacements.sort((left, right) =>
      right.start - left.start
    )) {
      rewritten = rewritten.slice(0, replacement.start)
        + replacement.text
        + rewritten.slice(replacement.end);
    }
    return rewritten;
  }

  return {
    resolve: retain,
    tryResolve: tryRetain,
    dispose,
    plugin(): Plugin {
      let config: ResolvedConfig | null = null;
      return {
        name: "source-only-verified-assets",
        enforce: "pre",
        configResolved(resolved) {
          config = resolved;
        },
        resolveId(source) {
          if (source.startsWith(MODULE_PREFIX)) {
            return retain(decodeURIComponent(source.slice(MODULE_PREFIX.length)));
          }
          return source.startsWith(VIRTUAL_PREFIX) ? source : null;
        },
        transform(code, id) {
          const rewritten = rewriteMirrorGlobs(code, id);
          return rewritten === null ? null : { code: rewritten, map: null };
        },
        load(id) {
          const asset = byVirtualId.get(id);
          if (asset === undefined) return null;
          if (config === null) {
            throw new Error("SourceOnly Vite asset loaded before config resolution");
          }
          if (config.command === "serve") {
            const publicPath =
              `${config.base}${PUBLIC_PREFIX}/${asset.sha256}/` +
              encodeURIComponent(basename(asset.relPath));
            byPublicPath.set(publicPath, asset);
            return `export default ${JSON.stringify(publicPath)};`;
          }
          const referenceId = this.emitFile({
            type: "asset",
            name: basename(asset.relPath),
            source: readFileSync(asset.snapshotPath),
          });
          return `export default import.meta.ROLLUP_FILE_URL_${referenceId};`;
        },
        configureServer(server: ViteDevServer) {
          server.httpServer?.once("close", dispose);
          server.middlewares.use((request, response, next) => {
            const pathname = new URL(
              request.url ?? "/",
              "http://127.0.0.1",
            ).pathname;
            const asset = byPublicPath.get(pathname);
            if (asset === undefined) {
              let publicRelPath: string;
              try {
                publicRelPath = decodeURIComponent(pathname).replace(/^\/+/, "");
              } catch {
                response.statusCode = 400;
                response.end("Malformed URL encoding");
                return;
              }
              if (options.denyPublicPath?.(publicRelPath) === true) {
                response.statusCode = 404;
                response.end("SourceOnly ambient public files are unavailable");
                return;
              }
              next();
              return;
            }
            if (request.method !== "GET" && request.method !== "HEAD") {
              response.statusCode = 405;
              response.end("Method not allowed");
              return;
            }
            response.statusCode = 200;
            response.setHeader("Content-Type", contentType(asset.relPath));
            response.setHeader("Content-Length", asset.size);
            response.setHeader("ETag", `\"${asset.sha256}\"`);
            response.setHeader(
              "Cache-Control",
              "public, max-age=31536000, immutable",
            );
            if (request.method === "HEAD") {
              response.end();
              return;
            }
            const stream = createReadStream(asset.snapshotPath);
            stream.on("error", (error) => response.destroy(error));
            stream.pipe(response);
          });
        },
      };
    },
  };
}
