import type {
  HomebrewGuestShippingBottleDigests,
} from "./homebrew_guest_lifecycle_contract";

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Project the on-disk diagnostic receipt into the shared guest-proof shape.
 *
 * WHY: prepared.json is a JSON/shell contract and therefore uses snake_case,
 * while the TypeScript lifecycle contract uses camelCase. Keep that boundary
 * explicit so a type assertion cannot silently turn both digests into
 * undefined and prevent the live browser proof from starting.
 */
export function projectRealInstallPreparedBottleDigests(
  value: unknown,
): HomebrewGuestShippingBottleDigests {
  if (!isRecord(value) || !isRecord(value.bottles)) {
    throw new Error("prepared diagnostic has no selected bottle digests");
  }
  const bottles = value.bottles;
  if (
    !hasExactKeys(bottles, ["core_bzip2_sha256", "core_dash_sha256"]) ||
    typeof bottles.core_bzip2_sha256 !== "string" ||
    !SHA256.test(bottles.core_bzip2_sha256) ||
    typeof bottles.core_dash_sha256 !== "string" ||
    !SHA256.test(bottles.core_dash_sha256)
  ) {
    throw new Error("prepared diagnostic has invalid selected bottle digests");
  }
  return {
    coreBzip2Sha256: bottles.core_bzip2_sha256,
    coreDashSha256: bottles.core_dash_sha256,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}
