import { KandeloImageFs } from '../../../images/vfs/lib/kandelo-image-fs';
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Plugin } from "vite";
import {
  SHARED_DESKTOP_LOGIN_PROGRAMS,
  sharedDesktopPrograms,
} from "../../../images/vfs/scripts/shared-desktop-contract";
import { sharedDesktopPackagePrograms } from "../../../images/vfs/scripts/shared-desktop-package-contract";

/** An explicit embedder build choice, never a capability enabled by a URL. */
export function trustedDesktopPreview(base: string, imagePath?: string, imageModuleBytes?: Uint8Array): Plugin | null {
  if (imagePath === undefined) return null;
  if (!isAbsolute(imagePath)) throw Error("Trusted desktop preview image must be an absolute path");
  const stat = lstatSync(imagePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > 512 * 1024 * 1024) {
    throw Error("Trusted desktop preview image must be a regular file of at most 512 MiB");
  }
  const image = readFileSync(imagePath);
  const sha256 = createHash("sha256").update(image).digest("hex");
  // A rebuilt preview must never reuse a service worker's old image response.
  const imageName = `trusted-desktop-preview/desktop-${sha256}.vfs.zst`;
  const provenanceName = `trusted-desktop-preview/provenance-${sha256}.json`;
  // The config bundler rebases module-relative paths. Its caller supplies
  // the normal resolver's exact image-reader bytes instead of a guessed path.
  const reader = KandeloImageFs.create(imageModuleBytes);
  let metadata: Record<string, any> | null;
  try { reader.loadImage(image); metadata = reader.getImageMetadata(); }
  finally { reader.reset(); }
  const packaged = metadata?.trustedMemoryGroup;
  const report = packaged === undefined
    ? JSON.parse(readFileSync(imagePath + ".memory-group.json", "utf8"))
    : (() => {
      if (packaged.schema !== 1 || packaged.package !== "shared-desktop-programs"
          || !metadata?.partialSelection?.packages?.includes("shared-desktop-programs")) {
        throw Error("Trusted desktop preview requires an explicitly selected SDK package");
      }
      return { output: { sha256, bytes: image.length }, programs: packaged.programs };
    })();
  if (report.output?.sha256 !== sha256 || report.output?.bytes !== image.length
      || !Array.isArray(report.programs)) {
    throw Error("Trusted desktop preview image differs from its SDK preparation report");
  }
  const participants = new Set(report.programs.map((program: { requested?: string }) => program.requested));
  // Package-backed images own their profiles. Validate the authored SDK
  // closure without manufacturing an app-side desktop description. The
  // adjacent report remains the contract for historical derived images.
  const requiredPrograms = packaged === undefined
    ? [...sharedDesktopPrograms(report.desktop?.profile ?? 'sway',
      report.desktop?.freeciv ?? false, report.desktop?.scummvm ?? false), ...SHARED_DESKTOP_LOGIN_PROGRAMS]
    : sharedDesktopPackagePrograms.map(program => program.requested ?? program.guestPath);
  for (const program of requiredPrograms) {
    if (!participants.has(program)) throw Error("Trusted desktop preview is missing participant " + program);
  }
  // Build-machine paths belong in the private SDK report, not the public site.
  const provenance = JSON.stringify({
    schema: 1, inputSha256: report.inputSha256, sha256, bytes: image.length,
    programs: report.programs.map((program: Record<string, unknown>) => ({
      requested: program.requested, path: program.path,
      ordinarySha256: program.ordinarySha256, groupedSha256: program.groupedSha256,
    })),
  }, null, 2) + "\n";
  return {
    name: "kandelo-trusted-desktop-preview",
    config() {
      return { define: {
        "import.meta.env.VITE_KANDELO_TRUSTED_MEMORY_GROUP": JSON.stringify("1"),
        "import.meta.env.VITE_KANDELO_TRUSTED_DESKTOP_IMAGE_URL": JSON.stringify(base + imageName),
      } };
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        const data = path === base + imageName ? image : path === base + provenanceName ? provenance : null;
        if (data === null) return next();
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }
        response.setHeader("Content-Type", path.endsWith(".json") ? "application/json" : "application/octet-stream");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Length", Buffer.byteLength(data));
        response.end(request.method === "HEAD" ? undefined : data);
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: imageName, source: image });
      this.emitFile({ type: "asset", fileName: provenanceName, source: provenance });
    },
  };
}
