import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ClosedLazyAsset } from "../host/src/vfs/closed-lazy-assets";
import type { SerializedLazyArchiveEntry } from "../host/src/vfs/memory-fs";
import {
  assertHomebrewBottleMirrorBundle,
  assertHomebrewBottleMirrorPlan,
  encodeHomebrewBottleMirrorPlan,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-vfs-composer";

export function loadHomebrewBottleMirrorBindings(
  planPath: string,
  embeddedPlanBytes: Uint8Array,
  pendingTrees: readonly SerializedLazyArchiveEntry[],
): ClosedLazyAsset[] {
  const planStat = lstatSync(planPath);
  if (!planStat.isFile() || planStat.isSymbolicLink()) {
    throw new Error(
      `bottle mirror plan is not a regular non-symlink file: ${planPath}`,
    );
  }
  const planBytes = new Uint8Array(readFileSync(planPath));
  if (!bytesEqual(planBytes, embeddedPlanBytes)) {
    throw new Error(
      "closed bottle mirror plan differs from the exact VFS-embedded plan",
    );
  }
  const plan = decodeHomebrewBottleMirrorPlan(planBytes, planPath);
  const decoded = plan as unknown as Record<string, unknown>;
  if (!isRecord(decoded) || !Array.isArray(decoded.assets)) {
    throw new Error("bottle mirror plan does not declare an asset array");
  }
  if (
    typeof decoded.manifest_asset !== "string" ||
    basename(planPath) !== decoded.manifest_asset
  ) {
    throw new Error(
      "bottle mirror plan filename differs from its declared asset name",
    );
  }

  const mirrorDir = dirname(planPath);
  const payloads = decoded.assets.map((value, index) => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.package !== "string" ||
      typeof value.asset !== "string" ||
      typeof value.sha256 !== "string"
    ) {
      throw new Error(
        `bottle mirror asset ${index} has invalid identity fields`,
      );
    }
    if (
      value.asset === "." ||
      value.asset === ".." ||
      basename(value.asset) !== value.asset
    ) {
      throw new Error(`bottle mirror asset ${index} filename is not canonical`);
    }
    const assetPath = join(mirrorDir, value.asset);
    const stat = lstatSync(assetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `bottle mirror asset is not a regular non-symlink file: ${assetPath}`,
      );
    }
    return {
      id: value.id,
      package: value.package,
      asset: value.asset,
      sha256: value.sha256,
      bytes: new Uint8Array(readFileSync(assetPath)),
    };
  });
  assertHomebrewBottleMirrorBundle(plan, payloads, {
    asset: basename(planPath) as "kandelo-homebrew-bottle-mirror-plan.json",
    sha256: createHash("sha256").update(planBytes).digest("hex"),
    bytes: planBytes,
  });
  assertPendingTreeHomebrewBottleMirrorBinding(pendingTrees, plan);
  const payloadByPackage = new Map(
    payloads.map((payload) => [payload.package, payload]),
  );
  return plan.assets.map((asset): ClosedLazyAsset => {
    const payload = payloadByPackage.get(asset.package);
    if (payload === undefined) {
      throw new Error(`bottle mirror payload is missing for ${asset.package}`);
    }
    return {
      url: asset.url,
      sha256: asset.sha256,
      size: asset.bytes,
      bytes: payload.bytes,
    };
  });
}

export function decodeHomebrewBottleMirrorPlan(
  planBytes: Uint8Array,
  label: string,
): HomebrewBottleMirrorPlan {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      planBytes,
    ));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON: ${String(error)}`);
  }
  if (!isRecord(decoded) || !Array.isArray(decoded.assets)) {
    throw new Error(`${label} does not declare a bottle mirror asset array`);
  }
  const plan = decoded as unknown as HomebrewBottleMirrorPlan;
  assertHomebrewBottleMirrorPlan(plan);
  if (!bytesEqual(planBytes, encodeHomebrewBottleMirrorPlan(plan))) {
    throw new Error(`${label} bytes are not canonical`);
  }
  return plan;
}

export function assertPendingTreeHomebrewBottleMirrorBinding(
  pendingTrees: readonly SerializedLazyArchiveEntry[],
  plan: HomebrewBottleMirrorPlan,
): void {
  if (pendingTrees.length !== plan.assets.length) {
    throw new Error(
      `pending tree count ${pendingTrees.length} differs from mirror asset count ` +
        `${plan.assets.length}`,
    );
  }
  const assetByUrl = new Map(plan.assets.map((asset) => [asset.url, asset]));
  if (assetByUrl.size !== plan.assets.length) {
    throw new Error("bottle mirror plan duplicates a release URL");
  }
  const seen = new Set<string>();
  for (const tree of pendingTrees) {
    const content = tree.content;
    const primaryUrl = content?.transports[0];
    const asset =
      primaryUrl === undefined ? undefined : assetByUrl.get(primaryUrl);
    if (
      content === undefined ||
      asset === undefined ||
      content.sha256 !== asset.sha256 ||
      content.bytes !== asset.bytes
    ) {
      throw new Error(
        `pending tree ${tree.mountPrefix} does not match one exact mirror asset`,
      );
    }
    if (seen.has(primaryUrl!)) {
      throw new Error(`multiple pending trees use mirror URL ${primaryUrl}`);
    }
    seen.add(primaryUrl!);
  }
  if (seen.size !== plan.assets.length) {
    throw new Error(
      "pending trees do not cover the complete bottle mirror plan",
    );
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
