#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertHomebrewBottleMirrorBundle,
  type HomebrewBottleMirrorPayload,
} from "../host/src/homebrew-vfs-composer";
import {
  loadHomebrewBottleMirrorClosedAssets,
  parseHomebrewBottleMirrorPlan,
} from "../host/src/homebrew-bottle-mirror-browser";
import {
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH,
} from "../host/src/homebrew-bottle-mirror-plan";
import { fetchHomebrewBottleBytes } from "../host/src/homebrew-vfs-fetch";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function recoverHomebrewBottleMirror(options: {
  imagePath: string;
  outputDirectory: string;
  reportPath: string;
  fetchImpl?: FetchLike;
  maxConcurrency?: number;
}): Promise<void> {
  const imagePath = resolve(options.imagePath);
  const outputDirectory = resolve(options.outputDirectory);
  const reportPath = resolve(options.reportPath);
  assertRegularFile(imagePath, "VFS image");
  assertAbsent(outputDirectory, "bottle mirror output");
  assertAbsent(reportPath, "bottle mirror recovery report");
  const reportWithinOutput = relative(outputDirectory, reportPath);
  if (
    reportWithinOutput === "" ||
    (!reportWithinOutput.startsWith("..") && !isAbsolute(reportWithinOutput))
  ) {
    throw new Error("bottle mirror recovery report must be outside the output directory");
  }

  const fs = MemoryFileSystem.fromImage(new Uint8Array(readFileSync(imagePath)));
  const embeddedPlanBytes = readVfsFile(fs, HOMEBREW_BOTTLE_MIRROR_PLAN_VFS_PATH);
  const guestManifest = parseGuestManifest(
    readVfsFile(fs, "/etc/kandelo/homebrew-vfs.json"),
  );
  // Reuse the browser parser with a fetch adapter backed by anonymous GHCR
  // source URLs. This binds the recovery path to the exact same canonical
  // plan and byte checks used by closed Chromium acceptance.
  const packageByFullName = new Map(
    guestManifest.packages.map((pkg) => [pkg.full_name, pkg]),
  );
  if (packageByFullName.size !== guestManifest.packages.length) {
    throw new Error("guest Homebrew manifest duplicates a package name");
  }
  const sourceByLocalAsset = new Map<string, GuestPackage>();
  const plan = await parseHomebrewBottleMirrorPlan(embeddedPlanBytes);
  if (guestManifest.catalog.tap_repository !== plan.repository) {
    throw new Error(
      "guest Homebrew catalog repository differs from the bottle mirror repository",
    );
  }
  for (const asset of plan.assets) {
    const pkg = packageByFullName.get(asset.package);
    if (pkg === undefined) {
      throw new Error(`guest Homebrew manifest omits ${asset.package}`);
    }
    assertAnonymousGhcrSource(pkg);
    if (pkg.sha256 !== asset.sha256 || pkg.bytes !== asset.bytes) {
      throw new Error(`guest bottle identity differs from mirror plan for ${asset.package}`);
    }
    if (sourceByLocalAsset.has(asset.asset)) {
      throw new Error(`embedded bottle mirror duplicates ${asset.asset}`);
    }
    sourceByLocalAsset.set(asset.asset, pkg);
  }

  const loaded = await loadHomebrewBottleMirrorClosedAssets({
    embeddedPlanBytes,
    bundleRoot: "/__kandelo_recovery",
    ...(options.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: options.maxConcurrency }),
    fetchImpl: async (input, init) => {
      const localPath = typeof input === "string" ? input : input.toString();
      const prefix = "/__kandelo_recovery/";
      if (!localPath.startsWith(prefix)) {
        throw new Error(`unexpected recovery fetch path: ${localPath}`);
      }
      const assetName = decodeURIComponent(localPath.slice(prefix.length));
      const pkg = sourceByLocalAsset.get(assetName);
      if (pkg === undefined) {
        throw new Error(`recovery fetch requested unknown asset ${assetName}`);
      }
      if (init?.credentials !== "omit" || init.redirect !== "error") {
        throw new Error("recovery fetch lost its anonymous closed-bundle contract");
      }
      const bytes = await fetchHomebrewBottleBytes(pkg.url, {
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      return new Response(copyArrayBuffer(bytes), {
        status: 200,
        headers: { "content-length": String(bytes.byteLength) },
      });
    },
  });
  const payloadByUrl = new Map(loaded.assets.map((asset) => [asset.url, asset]));
  const payloads: HomebrewBottleMirrorPayload[] = loaded.plan.assets.map((asset) => {
    const closed = payloadByUrl.get(asset.url)!;
    return {
      id: asset.id,
      package: asset.package,
      asset: asset.asset,
      sha256: asset.sha256,
      bytes: closed.bytes,
    };
  });
  assertHomebrewBottleMirrorBundle(loaded.plan, payloads, {
    asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    sha256: sha256(embeddedPlanBytes),
    bytes: embeddedPlanBytes,
  });

  const report = {
    schema: 1,
    kind: "kandelo-homebrew-bottle-mirror-recovery",
    repository: loaded.plan.repository,
    tag: loaded.plan.tag,
    collection_sha256: loaded.plan.collection_sha256,
    catalog: guestManifest.catalog,
    plan: {
      asset: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
      sha256: sha256(embeddedPlanBytes),
      bytes: embeddedPlanBytes.byteLength,
    },
    assets: loaded.plan.assets.map((asset) => ({
      ...asset,
      source_url: packageByFullName.get(asset.package)!.url,
    })),
  };
  mkdirSync(dirname(outputDirectory), { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  const staging = mkdtempSync(join(dirname(outputDirectory), ".kandelo-bottle-mirror-"));
  const reportStaging = mkdtempSync(join(dirname(reportPath), ".kandelo-mirror-report-"));
  const stagedReport = join(reportStaging, basename(reportPath));
  let outputMoved = false;
  let reportMoved = false;
  try {
    writeFileSync(join(staging, HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET), embeddedPlanBytes, {
      flag: "wx",
    });
    for (const payload of payloads) {
      writeFileSync(join(staging, payload.asset), payload.bytes, { flag: "wx" });
    }
    writeFileSync(stagedReport, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
    renameSync(staging, outputDirectory);
    outputMoved = true;
    renameSync(stagedReport, reportPath);
    reportMoved = true;
    rmSync(reportStaging, { recursive: true, force: true });
  } catch (error) {
    if (reportMoved) rmSync(reportPath, { force: true });
    if (outputMoved) {
      try {
        renameSync(outputDirectory, staging);
      } catch {
        rmSync(outputDirectory, { recursive: true, force: true });
      }
    }
    rmSync(staging, { recursive: true, force: true });
    rmSync(reportStaging, { recursive: true, force: true });
    throw error;
  }
}

interface GuestPackage {
  full_name: string;
  source_status: "success";
  url: string;
  sha256: string;
  bytes: number;
}

interface GuestCatalog {
  tap_repository: string;
  tap_name: string;
  checkout_commit: string;
}

function parseGuestManifest(bytes: Uint8Array): {
  catalog: GuestCatalog;
  packages: GuestPackage[];
} {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("guest Homebrew manifest is not valid UTF-8 JSON", { cause: error });
  }
  if (
    !isRecord(value) || !Array.isArray(value.packages) ||
    !isRecord(value.catalog)
  ) {
    throw new Error("guest Homebrew manifest does not declare catalog and packages");
  }
  const catalog = value.catalog;
  if (
    !hasExactKeys(catalog, ["tap_repository", "tap_name", "checkout_commit"]) ||
    typeof catalog.tap_repository !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(
      catalog.tap_repository,
    ) ||
    typeof catalog.tap_name !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(catalog.tap_name) ||
    typeof catalog.checkout_commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(catalog.checkout_commit)
  ) {
    throw new Error("guest Homebrew catalog has invalid provenance");
  }
  const packages = value.packages.map((entry, index): GuestPackage => {
    if (
      !isRecord(entry) || typeof entry.full_name !== "string" ||
      entry.source_status !== "success" || typeof entry.url !== "string" ||
      typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) <= 0
    ) {
      throw new Error(`guest Homebrew package ${index} has invalid source identity`);
    }
    return entry as unknown as GuestPackage;
  });
  return { catalog: catalog as unknown as GuestCatalog, packages };
}

function assertAnonymousGhcrSource(pkg: GuestPackage): void {
  let url: URL;
  try {
    url = new URL(pkg.url);
  } catch (error) {
    throw new Error(`guest bottle URL is invalid for ${pkg.full_name}`, { cause: error });
  }
  if (
    url.protocol !== "https:" || url.hostname !== "ghcr.io" ||
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
    !url.pathname.endsWith(`/blobs/sha256:${pkg.sha256}`)
  ) {
    throw new Error(`guest bottle URL is not one exact anonymous GHCR blob for ${pkg.full_name}`);
  }
}

function readVfsFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  if ((stat.mode & 0xf000) !== 0x8000) throw new Error(`${path} is not a regular file`);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.read(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (read <= 0) throw new Error(`short read from ${path}`);
      offset += read;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular non-symlink file: ${path}`);
  }
}

function assertAbsent(path: string, label: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function parseArgs(args: string[]) {
  if (
    args.length !== 6 || args[0] !== "--image" || !args[1] ||
    args[2] !== "--out" || !args[3] || args[4] !== "--report" || !args[5]
  ) {
    throw new Error(
      "usage: npx tsx scripts/recover-homebrew-bottle-mirror.ts " +
        "--image <shell.vfs.zst> --out <new-bundle-directory> --report <new-report.json>",
    );
  }
  return {
    imagePath: args[1],
    outputDirectory: args[3],
    reportPath: args[5],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await recoverHomebrewBottleMirror(parseArgs(process.argv.slice(2)));
}
