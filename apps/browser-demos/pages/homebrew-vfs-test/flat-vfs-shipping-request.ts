const SHA256_RE = /^[0-9a-f]{64}$/;
const TAP_REVISION_RE = /^[0-9a-f]{40}$/;

export interface HomebrewFlatVfsShippingProofRequest {
  allowLiveNetwork: true;
  vfsUrl: string;
  expectedImageSha256: string;
  expectedKernelSha256: string;
  shellPath: string;
  shellArgv0: string;
  tapRevision: string;
  timeoutMs: number;
}

export interface ValidatedHomebrewFlatVfsShippingProofRequest
  extends Omit<HomebrewFlatVfsShippingProofRequest, "vfsUrl"> {
  vfsUrl: URL;
}

export function validateHomebrewFlatVfsShippingProofRequest(
  request: HomebrewFlatVfsShippingProofRequest,
  context: { locationHref: string; actualKernelSha256: string },
): ValidatedHomebrewFlatVfsShippingProofRequest {
  if (request.allowLiveNetwork !== true) {
    throw new Error(
      "flat Homebrew VFS shipping proof requires explicit live-network opt-in",
    );
  }
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1_000 ||
    request.timeoutMs > 30 * 60_000
  ) {
    throw new Error("flat Homebrew VFS shipping proof timeout is invalid");
  }
  if (!TAP_REVISION_RE.test(request.tapRevision)) {
    throw new Error("flat Homebrew VFS tap revision is invalid");
  }
  if (!SHA256_RE.test(request.expectedImageSha256)) {
    throw new Error("flat Homebrew VFS image SHA-256 is invalid");
  }
  if (
    !SHA256_RE.test(request.expectedKernelSha256) ||
    !SHA256_RE.test(context.actualKernelSha256)
  ) {
    throw new Error("flat Homebrew VFS kernel SHA-256 is invalid");
  }
  if (request.expectedKernelSha256 !== context.actualKernelSha256) {
    throw new Error(
      "flat Homebrew VFS requested kernel SHA-256 does not match " +
        "the actual @kernel-wasm bytes",
    );
  }
  const location = new URL(context.locationHref);
  const vfsUrl = new URL(request.vfsUrl, location);
  if (
    vfsUrl.origin !== location.origin ||
    vfsUrl.username !== "" ||
    vfsUrl.password !== "" ||
    vfsUrl.hash !== "" ||
    !vfsUrl.pathname.endsWith(".vfs.zst")
  ) {
    throw new Error("flat Homebrew VFS image URL is invalid");
  }
  return { ...request, vfsUrl };
}
