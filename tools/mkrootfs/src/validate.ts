// Static validation over a parsed manifest, run before any FS work or
// archive ingestion. Catches user errors that the per-pass builder would
// otherwise surface as obscure mid-build failures (or worse, silently
// drop entries).
//
// Two surfaces are validated here:
//
//   1. Duplicate explicit paths inside the manifest itself — two node
//      entries (any combination of d/f/l/c/b) that claim the same path.
//      No deterministic resolution exists; refuse the build.
//
//   2. Archive ingestion overlaps — handled in `validateAndPlanArchives`
//      below, called by the builder once it has loaded zip indexes.
//      That function returns an extraction plan describing which archive
//      entries to skip (because an explicit f-entry overrides them) and
//      a list of audit warnings the caller can surface.
//
// The two surfaces are split because (1) is pure-text — runs immediately
// after parse, no FS — while (2) needs the zip directories already
// loaded.  Both share the same line-numbered error style.

import type {
  ManifestArchive,
  ManifestEntry,
  ManifestNode,
} from "./manifest.ts";
import type { ZipEntry } from "../../../host/src/vfs/zip";

export interface ArchiveBundle {
  archive: ManifestArchive;
  zipEntries: ZipEntry[];
}

export interface ArchiveExtractionPlan {
  /** Per-archive set of file paths (vfs absolute) to skip during extraction. */
  skipByArchiveUrl: Map<string, Set<string>>;
  /** Human-readable audit lines describing every override. */
  warnings: string[];
}

/**
 * Validate node entries in isolation. Throws on duplicate manifest paths
 * with both line numbers cited.
 */
export function validateManifestEntries(entries: ManifestEntry[]): void {
  const seen = new Map<string, ManifestNode>();
  for (const e of entries) {
    if (e.kind !== "node") continue;
    const prior = seen.get(e.path);
    if (prior) {
      throw new Error(
        `duplicate manifest path "${e.path}" — declared on line ${prior.lineNumber} and line ${e.lineNumber}`,
      );
    }
    seen.set(e.path, e);
  }
}

/**
 * Validate archive overlaps and produce an extraction plan.
 *
 * Errors:
 *   - same path shipped by two distinct archives → no deterministic resolution.
 *   - implicit f-entry (no src=) overlapping with archive content → ambiguous;
 *     the user must either drop the manifest entry or add src= to make the
 *     override intent explicit.
 *
 * Allowed (with audit warning):
 *   - explicit f-entry with src= overlapping with archive content; the
 *     manifest wins, the archive entry is filtered from extraction.
 */
export function validateAndPlanArchives(
  entries: ManifestEntry[],
  bundles: ArchiveBundle[],
): ArchiveExtractionPlan {
  const explicitFiles = new Map<string, ManifestNode>();
  for (const e of entries) {
    if (e.kind === "node" && e.type === "f") {
      explicitFiles.set(e.path, e);
    }
  }

  const skipByArchiveUrl = new Map<string, Set<string>>();
  const warnings: string[] = [];
  const archiveOwner = new Map<
    string,
    { url: string; lineNumber: number }
  >();

  for (const { archive, zipEntries } of bundles) {
    const base = normaliseBase(archive.base);
    const skip = new Set<string>();
    for (const ze of zipEntries) {
      if (ze.isDirectory) continue;
      const cleaned = ze.fileName.replace(/^\/+/, "");
      const vfsPath = base + "/" + cleaned;

      const prior = archiveOwner.get(vfsPath);
      if (prior && prior.url !== archive.url) {
        throw new Error(
          `archive collision at "${vfsPath}": shipped by both "${prior.url}" (manifest line ${prior.lineNumber}) and "${archive.url}" (manifest line ${archive.lineNumber})`,
        );
      }
      archiveOwner.set(vfsPath, {
        url: archive.url,
        lineNumber: archive.lineNumber,
      });

      const explicit = explicitFiles.get(vfsPath);
      if (!explicit) continue;
      if (!explicit.src) {
        throw new Error(
          `path "${vfsPath}" is declared as an implicit file (manifest line ${explicit.lineNumber}) and also shipped by archive "${archive.url}" (manifest line ${archive.lineNumber}); add src= to the manifest entry to make the override intent explicit, or remove the manifest entry to take the archive's content`,
        );
      }
      // Explicit src= override: the manifest wins. Skip during extraction
      // and surface as a warning so users can audit.
      skip.add(vfsPath);
      warnings.push(
        `override: "${vfsPath}" — manifest line ${explicit.lineNumber} (src=${explicit.src}) overrides archive "${archive.url}" (manifest line ${archive.lineNumber})`,
      );
    }
    skipByArchiveUrl.set(archive.url, skip);
  }

  return { skipByArchiveUrl, warnings };
}

function normaliseBase(base: string): string {
  return base === "/" ? "" : base.replace(/\/+$/, "");
}
