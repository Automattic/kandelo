import fs from "node:fs";
import path from "node:path";
import {
  normalizePath,
  type ViteDevServer,
} from "vite";

export interface BinaryDevAccess {
  approve(file: string): string;
  approveBatch(files: readonly string[]): string[];
  attachServer(server: ViteDevServer): void;
}

export interface BinaryDevAccessOptions {
  repoRoot: string;
  programCacheRoot: string;
  caseInsensitivePaths: boolean;
}

const invalidFsRequest = Symbol("invalid-fs-request");

function fsRequestPath(
  url: string | undefined,
): string | typeof invalidFsRequest | null {
  if (!url) return null;
  const pathname = new URL(url, "http://127.0.0.1").pathname;
  if (!pathname.startsWith("/@fs/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice("/@fs/".length));
  } catch {
    return invalidFsRequest;
  }
  let file = normalizePath(decoded);
  if (!path.isAbsolute(file) && !/^[A-Za-z]:\//.test(file)) file = `/${file}`;
  return normalizePath(file);
}

export function pathIsWithin(
  root: string,
  file: string,
  caseInsensitivePaths: boolean,
): boolean {
  const comparableRoot = caseInsensitivePaths ? root.toLowerCase() : root;
  const comparableFile = caseInsensitivePaths ? file.toLowerCase() : file;
  const fromRoot = path.relative(comparableRoot, comparableFile);
  return fromRoot === ""
    || (fromRoot !== ".."
      && !fromRoot.startsWith(`..${path.sep}`)
      && !path.isAbsolute(fromRoot));
}

/**
 * Give Vite access only to exact resolver-approved files outside the checkout.
 *
 * Batch approval deliberately validates every path before publishing any
 * capability. A malformed later package member must not make earlier members
 * from the same failed graph directly servable through Vite's broad lexical
 * transport allow-list.
 */
export function createBinaryDevAccess(
  options: BinaryDevAccessOptions,
): BinaryDevAccess {
  const approvedExternalFiles = new Set<string>();
  const attachedServers = new WeakSet<ViteDevServer>();
  const programCacheRoot = normalizePath(options.programCacheRoot);
  const repoRoot = normalizePath(options.repoRoot);

  function validate(file: string): {
    canonical: string;
    externalCapability: string | null;
  } {
    const canonical = normalizePath(fs.realpathSync(file));
    if (!fs.lstatSync(canonical).isFile()) {
      throw new Error(
        `Resolved browser artifact is not a regular file: ${canonical}`,
      );
    }
    const isInsideProgramCache = pathIsWithin(
      programCacheRoot,
      canonical,
      options.caseInsensitivePaths,
    );
    const isInsideRepo = pathIsWithin(
      repoRoot,
      canonical,
      options.caseInsensitivePaths,
    );
    if (isInsideProgramCache) {
      // The middleware guards the cache namespace even when an explicit cache
      // root overlaps the checkout, so every cache file needs an exact
      // capability regardless of repository containment.
      return { canonical, externalCapability: canonical };
    }
    if (!isInsideRepo) {
      throw new Error(
        `Resolved browser artifact is outside the Kandelo program cache: ${canonical}`,
      );
    }
    return { canonical, externalCapability: null };
  }

  const access: BinaryDevAccess = {
    approve(file: string): string {
      return access.approveBatch([file])[0]!;
    },
    approveBatch(files: readonly string[]): string[] {
      const validated = files.map(validate);
      // Commit only after every member is canonical, regular, and inside an
      // allowed root. This is the capability-side half of atomic graph
      // resolution; validation failure above leaves the set unchanged.
      for (const { externalCapability } of validated) {
        if (externalCapability !== null) {
          approvedExternalFiles.add(externalCapability);
        }
      }
      return validated.map(({ canonical }) => canonical);
    },
    attachServer(nextServer: ViteDevServer): void {
      if (attachedServers.has(nextServer)) return;
      attachedServers.add(nextServer);
      nextServer.middlewares.use((request, response, next) => {
        const requested = fsRequestPath(request.url);
        if (requested === invalidFsRequest) {
          response.statusCode = 403;
          response.end("Malformed filesystem path");
          return;
        }
        if (
          !requested
          || !pathIsWithin(
            programCacheRoot,
            requested,
            options.caseInsensitivePaths,
          )
        ) {
          next();
          return;
        }
        try {
          if (
            !approvedExternalFiles.has(requested)
            || !fs.lstatSync(requested).isFile()
            || normalizePath(fs.realpathSync(requested)) !== requested
          ) {
            response.statusCode = 403;
            response.end("Forbidden resolver-cache path");
            return;
          }
        } catch {
          response.statusCode = 403;
          response.end("Forbidden resolver-cache path");
          return;
        }
        next();
      });
    },
  };
  return access;
}
