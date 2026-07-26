import type { SerializedLazyArchiveEntry } from "../host/src/vfs/memory-fs";
import {
  encodeHomebrewBottleMirrorCollectionIdentity,
  encodeHomebrewBottleMirrorPlan,
  projectHomebrewBottleMirrorPlan,
  type HomebrewBottleMirrorPlan,
} from "../host/src/homebrew-bottle-mirror-plan";

/**
 * Decode the byte-canonical bottle mirror plan shared by Node and browser
 * acceptance. Keeping this parser browser-safe prevents the two hosts from
 * accepting different release identities.
 */
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
  const plan = projectHomebrewBottleMirrorPlan(decoded);
  if (!bytesEqual(planBytes, encodeHomebrewBottleMirrorPlan(plan))) {
    throw new Error(`${label} bytes are not canonical`);
  }
  return plan;
}

/** Validate the content-derived release identity with browser Web Crypto. */
export async function assertHomebrewBottleMirrorPlanIdentity(
  plan: HomebrewBottleMirrorPlan,
): Promise<void> {
  const normalized = projectHomebrewBottleMirrorPlan(plan);
  const collectionSha = await sha256(
    encodeHomebrewBottleMirrorCollectionIdentity(
      normalized.repository,
      normalized.assets,
    ),
  );
  const tag = `homebrew-shell-bottles-sha256-${collectionSha}`;
  const releaseRoot =
    `https://github.com/${normalized.repository}/releases/download/${tag}`;
  if (
    normalized.collection_sha256 !== collectionSha ||
    normalized.tag !== tag ||
    normalized.release_root !== releaseRoot ||
    normalized.assets.some(
      (asset) => asset.url !== `${releaseRoot}/${asset.asset}`,
    )
  ) {
    throw new Error(
      "Homebrew bottle mirror plan has inconsistent derived identity",
    );
  }
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

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(owned).set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", owned),
  );
  return Array.from(
    digest,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
