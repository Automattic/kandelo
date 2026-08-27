const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const PERCENT_ESCAPE = /%[0-9a-f]{2}/iu;

export function validateVfsAssetGroupRelativePath(value: unknown): string {
  if (!isSafeRelativePath(value)) {
    throw new Error("VFS asset group path is invalid");
  }
  return value;
}

/** Normalize the complete legacy reference grammar carried by product images. */
export function normalizeImageOwnedLazyReference(reference: string): string {
  const binaryPrefix = "binaries/programs/wasm32/";
  if (reference.startsWith(binaryPrefix)) {
    const path = reference.slice(binaryPrefix.length);
    validateVfsAssetGroupRelativePath(path);
    return `assets/programs/wasm32/${path}`;
  }
  const lazyPrefix = "kandelo-lazy:programs/";
  if (reference.startsWith(lazyPrefix)) {
    const path = reference.slice(lazyPrefix.length);
    validateVfsAssetGroupRelativePath(path);
    return `assets/programs/wasm32/${path}`;
  }
  if (
    reference === "vim.zip" || reference === "nethack.zip" ||
    reference === "ruby.zip" || reference === "python.zip"
  ) {
    return `assets/programs/wasm32/${reference}`;
  }
  throw new Error("Image-owned lazy runtime reference is invalid");
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
