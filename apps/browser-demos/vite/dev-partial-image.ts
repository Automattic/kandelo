// Serve this worktree's partial image (`./run.sh partial <image> <pkg>...`)
// from the dev server, as its own gallery machine.
//
// A partial image is composed from the rootfs base plus a few named packages
// so a developer can try them without building the whole shell
// (docs/superpowers/specs/2026-11-07-partial-image-builds-design.md). It lives
// in local-binaries/partial/ beside partial.json, which says what it carries.
//
// Two rules make it safe to iterate on:
// - It is never cached. The route answers with `Cache-Control: no-store`, and
//   the service worker passes the route straight to the network, so a rebuilt
//   image is what the next boot reads.
// - The page always describes the image that is on disk. The manifest is a
//   virtual module, and a rebuild invalidates it and reloads the page.
//
// The image does not go through the SourceOnly snapshot store: that store pins
// one generation for the server's lifetime, which is exactly what a partial
// image must not do. Its lazy files are package members, served by the
// ordinary lazy-asset route like any other image's.
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { browserPartialImageModuleSpecifier } from "../browser-module-contract.mjs";

export const PARTIAL_IMAGE_VIRTUAL_MODULE = browserPartialImageModuleSpecifier;
const RESOLVED_VIRTUAL_MODULE = `\0${PARTIAL_IMAGE_VIRTUAL_MODULE}`;
/** The dev-server route, relative to the deployment base. */
export const PARTIAL_IMAGE_ROUTE = "@kandelo-partial/";
const IMAGE_NAME = "image.vfs.zst";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_DEMO_CONFIG_BYTES = 256 * 1024;

export interface PartialImageManifest {
  schema: 1;
  image: string;
  productId: string;
  file: string;
  sha256: string;
  bytes: number;
  packages: string[];
  selection: string[];
  activities: string[];
  excludedActivities: Array<{ profile: string; missing: string[] }>;
  builtAt: string;
}

/** What the page imports: the image's URL, manifest and demo config. */
export interface PartialImageModule {
  imageUrl: string;
  manifest: PartialImageManifest;
  demoConfig: unknown;
}

const PACKAGE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const FILE_NAME = /^[a-z0-9][a-z0-9-]*-partial\.vfs\.zst$/;

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !PACKAGE_NAME.test(entry))) {
    throw new Error(`partial.json ${field} must be a list of names`);
  }
  return value as string[];
}

/** Parse partial.json, failing loudly on anything this route would mis-serve. */
export function parsePartialImageManifest(text: string): PartialImageManifest {
  const value = JSON.parse(text) as Record<string, unknown>;
  if (value === null || typeof value !== "object" || value.schema !== 1) {
    throw new Error("partial.json must be schema 1");
  }
  if (typeof value.file !== "string" || !FILE_NAME.test(value.file)) {
    throw new Error("partial.json file must name a <image>-partial.vfs.zst");
  }
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error("partial.json sha256 must be a lowercase hex SHA-256");
  }
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) <= 0) {
    throw new Error("partial.json bytes must be the image size");
  }
  for (const field of ["image", "productId", "builtAt"] as const) {
    if (typeof value[field] !== "string") throw new Error(`partial.json ${field} must be a string`);
  }
  const excluded = value.excludedActivities;
  if (!Array.isArray(excluded)) throw new Error("partial.json excludedActivities must be a list");
  return {
    schema: 1,
    image: value.image as string,
    productId: value.productId as string,
    file: value.file,
    sha256: value.sha256,
    bytes: value.bytes as number,
    packages: stringList(value.packages, "packages"),
    selection: stringList(value.selection, "selection"),
    activities: stringList(value.activities, "activities"),
    excludedActivities: excluded.map((entry: { profile?: unknown; missing?: unknown }) => ({
      profile: stringList([entry.profile], "excludedActivities.profile")[0]!,
      missing: stringList(entry.missing, "excludedActivities.missing"),
    })),
    builtAt: value.builtAt as string,
  };
}

function readBounded(file: string, limit: number): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) throw new Error(`${file} must be a regular file`);
  if (stat.size > limit) throw new Error(`${file} exceeds ${limit} bytes`);
  return fs.readFileSync(file, "utf8");
}

/** The module the page imports, or `null` when no partial image is built. */
export function loadPartialImageModule(
  partialDir: string,
  base: string,
): PartialImageModule | null {
  const manifestText = readBounded(path.join(partialDir, "partial.json"), MAX_MANIFEST_BYTES);
  if (manifestText === null) return null;
  const manifest = parsePartialImageManifest(manifestText);
  const demoText = readBounded(path.join(partialDir, "demo.json"), MAX_DEMO_CONFIG_BYTES);
  if (demoText === null) {
    throw new Error(`${partialDir}/demo.json is missing; rebuild with ./run.sh partial`);
  }
  return {
    imageUrl: `${base}${PARTIAL_IMAGE_ROUTE}${IMAGE_NAME}`,
    manifest,
    demoConfig: JSON.parse(demoText),
  };
}

/** Whether `pathname` (already stripped of the query) is this route's image. */
export function isPartialImageRequest(pathname: string, base: string): boolean {
  return pathname === `${base}${PARTIAL_IMAGE_ROUTE}${IMAGE_NAME}`;
}

export function devPartialImage(options: { partialDir: string }): Plugin {
  let base = "/";
  let serving = false;
  return {
    name: "kandelo-dev-partial-image",
    enforce: "pre",
    configResolved(config) {
      base = config.base;
      serving = config.command === "serve";
    },
    resolveId(source) {
      return source === PARTIAL_IMAGE_VIRTUAL_MODULE ? RESOLVED_VIRTUAL_MODULE : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_MODULE) return null;
      // A production build never carries a worktree's partial image.
      const module = serving ? loadPartialImageModule(options.partialDir, base) : null;
      return `export default ${JSON.stringify(module)};\n`;
    },
    configureServer(server) {
      server.watcher.add(path.join(options.partialDir, "partial.json"));
      server.watcher.on("all", (_event, file) => {
        if (path.resolve(file) !== path.resolve(options.partialDir, "partial.json")) return;
        const module = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_MODULE);
        if (module !== undefined) server.moduleGraph.invalidateModule(module);
        server.ws.send({ type: "full-reload" });
      });
      server.middlewares.use((req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        if (!isPartialImageRequest(pathname, base)) return next();
        let manifest: PartialImageManifest;
        try {
          const text = readBounded(path.join(options.partialDir, "partial.json"), MAX_MANIFEST_BYTES);
          if (text === null) {
            res.statusCode = 404;
            res.end("No partial image is built in this worktree (./run.sh partial <image> <pkg>...)");
            return;
          }
          manifest = parsePartialImageManifest(text);
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error));
          return;
        }
        const file = path.join(options.partialDir, manifest.file);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(file);
        } catch {
          res.statusCode = 404;
          res.end(`${manifest.file} named by partial.json is missing`);
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/zstd");
        res.setHeader("Content-Length", String(stat.size));
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Kandelo-Partial-Image-Sha256", manifest.sha256);
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
