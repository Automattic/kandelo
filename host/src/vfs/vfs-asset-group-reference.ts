const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/iu;

export function validateVfsAssetGroupRelativePath(value: unknown): string {
  if (!isSafeRelativePath(value)) {
    throw new Error("VFS asset group path is invalid");
  }
  return value;
}

/**
 * The package member a product image's lazy address names.
 *
 * Every address is self-describing: `binaries/programs/<path>` (the rootfs's
 * lazy outputs) or `kandelo-lazy:programs/<path>` (the shell's lazy files and
 * archives), where `programs/<path>` is the package-mirror path and a path
 * without an architecture is wasm32. The result is the member's asset-group
 * path, `assets/programs/<arch>/<path>`. No address is special-cased by name,
 * so adding an image entry never needs an edit here.
 */
export function normalizeImageOwnedLazyReference(reference: string): string {
  for (const prefix of ["binaries/programs/", "kandelo-lazy:programs/"]) {
    if (!reference.startsWith(prefix)) continue;
    const path = reference.slice(prefix.length);
    validateVfsAssetGroupRelativePath(path);
    const arch = path.split("/", 1)[0];
    const member = arch === "wasm32" || arch === "wasm64" ? path : `wasm32/${path}`;
    if (member.split("/").length < 2) break;
    return `assets/programs/${member}`;
  }
  throw new Error("Image-owned lazy runtime reference is invalid");
}

/**
 * The URL under `directory` that serves an address a product image records,
 * or `null` when the address is outside the image-owned grammar.
 *
 * `directory` is where the deployment serves package members: an asset
 * group's directory in production, a dev-server route in development. Each
 * address normalizes to its member path (`assets/programs/wasm32/...`), so
 * no deployment needs a table naming every lazy file an image might carry.
 */
export function resolveImageOwnedLazyAsset(
  directory: string,
  reference: string,
): string | null {
  let member: string;
  try {
    member = normalizeImageOwnedLazyReference(reference);
  } catch {
    return null;
  }
  const base = new URL(directory);
  if (!base.pathname.endsWith("/") || base.search !== "" || base.hash !== "") {
    throw new Error("Image-owned lazy asset directory is invalid");
  }
  const resolved = new URL(member, base);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    throw new Error("Image-owned lazy asset escaped its directory");
  }
  return resolved.href;
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("?") ||
    value.includes("#") ||
    URL_SCHEME.test(value)
  )
    return false;
  for (const segment of value.split("/")) {
    if (segment === "") return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0") ||
      PERCENT_ESCAPE.test(decoded)
    )
      return false;
  }
  return true;
}
