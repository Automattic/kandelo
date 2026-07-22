#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHomebrewBottleMirrorPlan } from "../host/src/homebrew-bottle-mirror-browser";
import {
  HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-bottle-mirror-plan";

const RECOVERY_KIND = "kandelo-homebrew-bottle-mirror-recovery";
const PUBLISH_TITLE = "Kandelo Homebrew shell bottle mirror";

export async function createHomebrewBottleMirrorPublishManifest(options: {
  bundleDirectory: string;
  recoveryReportPath: string;
  outputPath: string;
}): Promise<void> {
  const bundleDirectory = resolve(options.bundleDirectory);
  const recoveryReportPath = resolve(options.recoveryReportPath);
  const outputPath = resolve(options.outputPath);
  assertDirectory(bundleDirectory, "bottle mirror bundle");
  assertRegularFile(recoveryReportPath, "bottle mirror recovery report");
  assertAbsent(outputPath, "bottle mirror publish manifest");
  const outputWithinBundle = relative(bundleDirectory, outputPath);
  if (
    outputWithinBundle === "" ||
    (!outputWithinBundle.startsWith("..") && !isAbsolute(outputWithinBundle))
  ) {
    throw new Error("bottle mirror publish manifest must be outside the asset root");
  }

  const planBytes = new Uint8Array(readFileSync(
    join(bundleDirectory, HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET),
  ));
  const plan = await parseHomebrewBottleMirrorPlan(planBytes);
  const report = parseRecoveryReport(readFileSync(recoveryReportPath, "utf8"));
  assertReportMatchesPlan(report, plan, planBytes);

  const expectedNames = [
    HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    ...plan.assets.map((asset) => asset.asset),
  ];
  const actualEntries = readdirSync(bundleDirectory, { withFileTypes: true });
  if (
    actualEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) ||
    JSON.stringify(actualEntries.map((entry) => entry.name).sort()) !==
      JSON.stringify([...expectedNames].sort())
  ) {
    throw new Error("bottle mirror asset root differs from the exact mirror plan");
  }

  const declaredAssets = [{
    name: HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET,
    sha256: sha256(planBytes),
    bytes: planBytes.byteLength,
  }, ...plan.assets.map((asset) => ({
    name: asset.asset,
    sha256: asset.sha256,
    bytes: asset.bytes,
  }))];
  for (const asset of declaredAssets) {
    const path = join(bundleDirectory, asset.name);
    assertRegularFile(path, `bottle mirror asset ${asset.name}`);
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) {
      throw new Error(`bottle mirror asset ${asset.name} differs from its plan`);
    }
  }

  const manifest = {
    schema: 1,
    repository: plan.repository,
    tag: plan.tag,
    target_commitish: report.catalog.checkout_commit,
    title: PUBLISH_TITLE,
    body:
      "Immutable mirror of the deferred Homebrew bottles used by the " +
      `Kandelo shell. Collection SHA-256: ${plan.collection_sha256}.`,
    assets: declaredAssets,
    preferred_asset_names: expectedNames,
    accepted_existing_asset_sets: [],
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
}

interface RecoveryReport {
  schema: 1;
  kind: typeof RECOVERY_KIND;
  repository: string;
  tag: string;
  collection_sha256: string;
  catalog: {
    tap_repository: string;
    tap_name: string;
    checkout_commit: string;
  };
  plan: { asset: string; sha256: string; bytes: number };
  assets: Array<{
    id: string;
    package: string;
    asset: string;
    sha256: string;
    bytes: number;
    url: string;
    source_url: string;
  }>;
}

function parseRecoveryReport(text: string): RecoveryReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("bottle mirror recovery report is not valid JSON", { cause: error });
  }
  if (
    !isRecord(value) || !hasExactKeys(value, [
      "schema", "kind", "repository", "tag", "collection_sha256",
      "catalog", "plan", "assets",
    ]) ||
    value.schema !== 1 || value.kind !== RECOVERY_KIND ||
    typeof value.repository !== "string" || typeof value.tag !== "string" ||
    typeof value.collection_sha256 !== "string" ||
    !isRecord(value.catalog) || !hasExactKeys(value.catalog, [
      "tap_repository", "tap_name", "checkout_commit",
    ]) ||
    typeof value.catalog.tap_repository !== "string" ||
    typeof value.catalog.tap_name !== "string" ||
    typeof value.catalog.checkout_commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.catalog.checkout_commit) ||
    !isRecord(value.plan) || !hasExactKeys(value.plan, [
      "asset", "sha256", "bytes",
    ]) ||
    typeof value.plan.asset !== "string" ||
    typeof value.plan.sha256 !== "string" ||
    !Number.isSafeInteger(value.plan.bytes) ||
    !Array.isArray(value.assets)
  ) {
    throw new Error("bottle mirror recovery report has invalid fields");
  }
  for (const [index, asset] of value.assets.entries()) {
    if (
      !isRecord(asset) || !hasExactKeys(asset, [
        "id", "package", "asset", "sha256", "bytes", "url", "source_url",
      ]) ||
      typeof asset.id !== "string" || typeof asset.package !== "string" ||
      typeof asset.asset !== "string" || typeof asset.sha256 !== "string" ||
      !Number.isSafeInteger(asset.bytes) || typeof asset.url !== "string" ||
      typeof asset.source_url !== "string"
    ) {
      throw new Error(`bottle mirror recovery asset ${index} has invalid fields`);
    }
  }
  return value as unknown as RecoveryReport;
}

function assertReportMatchesPlan(
  report: RecoveryReport,
  plan: HomebrewBottleMirrorPlan,
  planBytes: Uint8Array,
): void {
  if (
    report.repository !== plan.repository || report.tag !== plan.tag ||
    report.collection_sha256 !== plan.collection_sha256 ||
    report.catalog.tap_repository !== plan.repository ||
    report.plan.asset !== HOMEBREW_BOTTLE_MIRROR_PLAN_ASSET ||
    report.plan.sha256 !== sha256(planBytes) ||
    report.plan.bytes !== planBytes.byteLength ||
    report.assets.length !== plan.assets.length ||
    report.assets.some((asset, index) => {
      const planned = plan.assets[index]!;
      return asset.id !== planned.id || asset.package !== planned.package ||
        asset.asset !== planned.asset || asset.sha256 !== planned.sha256 ||
        asset.bytes !== planned.bytes || asset.url !== planned.url;
    })
  ) {
    throw new Error("bottle mirror recovery report differs from the exact mirror plan");
  }
}

function assertRegularFile(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular non-symlink file: ${path}`);
  }
}

function assertDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular non-symlink directory: ${path}`);
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

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(args: string[]) {
  if (
    args.length !== 6 || args[0] !== "--bundle" || !args[1] ||
    args[2] !== "--recovery-report" || !args[3] ||
    args[4] !== "--out" || !args[5]
  ) {
    throw new Error(
      "usage: npx tsx scripts/create-homebrew-bottle-mirror-publish-manifest.ts " +
        "--bundle <bottle-mirror-directory> --recovery-report <report.json> " +
        "--out <new-publish-manifest.json>",
    );
  }
  return {
    bundleDirectory: args[1],
    recoveryReportPath: args[3],
    outputPath: args[5],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await createHomebrewBottleMirrorPublishManifest(parseArgs(process.argv.slice(2)));
}
