/**
 * Shared core for the Homebrew framebuffer/device smoke: the per-formula specs
 * and the VFS-pour logic. Reused by scripts/homebrew-package-framebuffer-smoke.ts
 * (the standalone runner) and apps/browser-demos/test/homebrew-framebuffer.spec.ts
 * (the CI-gated Playwright spec).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ABI_VERSION } from "../host/src/generated/abi";
import type { HomebrewBottleArch, HomebrewVfsPackagePlan } from "../host/src/homebrew-vfs-planner";

export interface FbSpec {
  argv: string[];
  device: string;
  mode: "fb" | "kms";
  needsWad: boolean;
  minWrites: number;
  description: string;
}

export const FB_SPECS: Record<string, FbSpec> = {
  fbdoom: {
    argv: ["/home/linuxbrew/.linuxbrew/bin/fbdoom", "-iwad", "/doom1.wad"],
    device: "/dev/fb0",
    mode: "fb",
    needsWad: true,
    minWrites: 1,
    description: "fbdoom renders DOOM to /dev/fb0 from the poured Homebrew keg + shareware IWAD.",
  },
  modeset: {
    argv: ["/home/linuxbrew/.linuxbrew/bin/modeset"],
    device: "/dev/dri/card0",
    mode: "kms",
    needsWad: false,
    minWrites: 1,
    description: "modeset drives an EGL/GLES fluid sim through /dev/dri/card0 page flips.",
  },
};

/** DOOM shareware IWAD (id Software, freely redistributable). */
export const DOOM_WAD_URL = "https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad";
export const DOOM_WAD_SHA256 = "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771";

export interface FbSmokeResult {
  mode: "fb" | "kms";
  binds: number;
  unbinds: number;
  writes: number;
  writeBytes: number;
  kmsBlits: number;
  kmsCommits: number;
  boundPid: number | null;
  width: number;
  height: number;
  fmt: string | null;
  canvasNonBlankPixels: number;
  exitedEarly: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export async function loadBottleBytes(
  pkg: HomebrewVfsPackagePlan,
  opts: { bottleCache: string },
): Promise<Uint8Array> {
  if (pkg.url.startsWith("file://")) {
    return new Uint8Array(readFileSync(fileURLToPath(pkg.url)));
  }
  const cachePath = `${opts.bottleCache}/${pkg.sha256}.tar.gz`;
  if (existsSync(cachePath)) return new Uint8Array(readFileSync(cachePath));
  if (!pkg.url.startsWith("https://")) {
    throw new Error(`package ${pkg.name}@${pkg.version} bottle URL must be https:// or file://, got ${pkg.url}`);
  }
  const { fetchHomebrewBottleBytes } = await import("../host/src/homebrew-vfs-fetch");
  const bytes = await fetchHomebrewBottleBytes(pkg.url);
  mkdirSync(opts.bottleCache, { recursive: true });
  writeFileSync(cachePath, bytes);
  return bytes;
}

function createFs(
  MemoryFileSystemCtor: { create(sab: SharedArrayBuffer, maxBytes?: number): unknown },
  maxBytes: number,
): unknown {
  const SharedArrayBufferCtor = SharedArrayBuffer as new (
    byteLength: number,
    options?: { maxByteLength?: number },
  ) => SharedArrayBuffer;
  return MemoryFileSystemCtor.create(new SharedArrayBufferCtor(maxBytes, { maxByteLength: maxBytes }), maxBytes);
}

export interface PourOptions {
  tapRoot: string;
  formula: string;
  arch: HomebrewBottleArch;
  bottleCache: string;
  wadFile?: string;
  maxBytes?: number;
  /** Target path for the written .vfs.zst image. */
  outImagePath: string;
  createdBy?: string;
}

/**
 * Pour a single Homebrew package into a bootable VFS image for the framebuffer
 * smoke, injecting the DOOM shareware IWAD at /doom1.wad for fbdoom. Writes the
 * image to `outImagePath` and returns its device mode.
 */
export async function pourHomebrewFbVfs(opts: PourOptions): Promise<{ imagePath: string; mode: "fb" | "kms" }> {
  const spec = FB_SPECS[opts.formula];
  if (!spec) throw new Error(`unsupported framebuffer formula ${opts.formula}`);
  const maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
  const [{ buildHomebrewVfs }, { planHomebrewVfs }, { MemoryFileSystem }, helpers] = await Promise.all([
    import("../host/src/homebrew-vfs-builder"),
    import("../host/src/homebrew-vfs-planner"),
    import("../host/src/vfs/memory-fs"),
    import("../images/vfs/scripts/vfs-image-helpers"),
  ]);
  const metadata = readJsonFile(`${opts.tapRoot}/Kandelo/metadata.json`);
  const plan = await planHomebrewVfs(metadata as never, {
    packages: [opts.formula],
    arch: opts.arch,
    expectedAbi: ABI_VERSION,
    loadLinkManifest: (relPath: string) => readJsonFile(`${opts.tapRoot}/${relPath}`),
  });
  const fs = createFs(
    MemoryFileSystem as unknown as { create(sab: SharedArrayBuffer, maxBytes?: number): unknown },
    maxBytes,
  );
  await buildHomebrewVfs(plan, {
    fs: fs as never,
    createdBy: opts.createdBy ?? "scripts/homebrew-fb-vfs.ts",
    loadBottleBytes: (pkg: HomebrewVfsPackagePlan) => loadBottleBytes(pkg, { bottleCache: opts.bottleCache }),
  });

  if (spec.needsWad) {
    if (!opts.wadFile || !existsSync(opts.wadFile)) {
      throw new Error(`${opts.formula} requires the DOOM shareware IWAD; provide wadFile (fetch ${DOOM_WAD_URL})`);
    }
    helpers.writeVfsBinary(fs as never, "/doom1.wad", new Uint8Array(readFileSync(opts.wadFile)), 0o644);
  }

  mkdirSync(opts.outImagePath.replace(/\/[^/]+$/, ""), { recursive: true });
  await helpers.saveImage(fs as never, opts.outImagePath, {
    metadata: { version: 1, kernelAbi: plan.kandeloAbi, createdBy: opts.createdBy ?? "scripts/homebrew-fb-vfs.ts" },
  });
  return { imagePath: opts.outImagePath, mode: spec.mode };
}
