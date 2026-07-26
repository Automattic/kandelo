import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ClosedLazyAsset } from "../host/src/vfs/closed-lazy-assets";
import type { SerializedLazyArchiveEntry } from "../host/src/vfs/memory-fs";
import {
  assertHomebrewBottleMirrorBundle,
  assertHomebrewBottleMirrorPlan,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-vfs-composer";
import {
  assertPendingTreeHomebrewBottleMirrorBinding,
  bytesEqual,
  decodeHomebrewBottleMirrorPlan as decodeHomebrewBottleMirrorPlanStructure,
  isRecord,
} from "./homebrew-closed-lazy-assets-contract";

export {
  assertPendingTreeHomebrewBottleMirrorBinding,
} from "./homebrew-closed-lazy-assets-contract";

export function decodeHomebrewBottleMirrorPlan(
  planBytes: Uint8Array,
  label: string,
): HomebrewBottleMirrorPlan {
  const plan = decodeHomebrewBottleMirrorPlanStructure(planBytes, label);
  assertHomebrewBottleMirrorPlan(plan);
  return plan;
}

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
