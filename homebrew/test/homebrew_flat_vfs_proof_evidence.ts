import type {
  HomebrewFlatVfsShippingProofResult,
} from "./homebrew_flat_vfs_shipping_proof";

const SHA256_RE = /^[0-9a-f]{64}$/;
const TAP_REVISION_RE = /^[0-9a-f]{40}$/;

export interface HomebrewFlatVfsProofFileIdentity {
  sha256: string;
  bytes: number;
}

export interface HomebrewFlatVfsProofEvidence {
  schema: 1;
  kind: "kandelo-homebrew-flat-vfs-proof";
  host: "node" | "chromium";
  arch: "wasm32";
  kandelo_abi: 42;
  tap_revision: string;
  selection_sha256: string;
  image: HomebrewFlatVfsProofFileIdentity;
  report: HomebrewFlatVfsProofFileIdentity;
  kernel: HomebrewFlatVfsProofFileIdentity;
  lazy_downloads: 0;
}

export function buildHomebrewFlatVfsProofEvidence(input: {
  host: "node" | "chromium";
  tapRevision: string;
  selectionSha256: string;
  image: HomebrewFlatVfsProofFileIdentity;
  report: HomebrewFlatVfsProofFileIdentity;
  kernel: HomebrewFlatVfsProofFileIdentity;
  proof: HomebrewFlatVfsShippingProofResult;
}): HomebrewFlatVfsProofEvidence {
  if (input.host !== "node" && input.host !== "chromium") {
    throw new Error("flat Homebrew VFS evidence host is invalid");
  }
  if (!TAP_REVISION_RE.test(input.tapRevision)) {
    throw new Error("flat Homebrew VFS evidence tap revision is invalid");
  }
  if (!SHA256_RE.test(input.selectionSha256)) {
    throw new Error("flat Homebrew VFS evidence selection SHA-256 is invalid");
  }
  const image = exactFileIdentity(input.image, "image");
  const report = exactFileIdentity(input.report, "report");
  const kernel = exactFileIdentity(input.kernel, "kernel");
  if (input.proof.tapRevision !== input.tapRevision) {
    throw new Error("flat Homebrew VFS proof tap revision does not match evidence");
  }
  if (input.proof.kandeloAbi !== 42) {
    throw new Error("flat Homebrew VFS proof must use Kandelo ABI 42");
  }
  if (input.proof.selectionSha256 !== input.selectionSha256) {
    throw new Error(
      "flat Homebrew VFS proof selection SHA-256 does not match evidence",
    );
  }
  if (
    !Array.isArray(input.proof.lazyDownloads) ||
    input.proof.lazyDownloads.length !== 0
  ) {
    throw new Error("flat Homebrew VFS proof must have zero lazy downloads");
  }
  return {
    schema: 1,
    kind: "kandelo-homebrew-flat-vfs-proof",
    host: input.host,
    arch: "wasm32",
    kandelo_abi: 42,
    tap_revision: input.tapRevision,
    selection_sha256: input.selectionSha256,
    image,
    report,
    kernel,
    lazy_downloads: 0,
  };
}

export function encodeHomebrewFlatVfsProofEvidence(
  evidence: HomebrewFlatVfsProofEvidence,
): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(evidence, null, 2)}\n`);
}

function exactFileIdentity(
  value: HomebrewFlatVfsProofFileIdentity,
  label: string,
): HomebrewFlatVfsProofFileIdentity {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.prototype.hasOwnProperty.call(value, "sha256") ||
    !Object.prototype.hasOwnProperty.call(value, "bytes") ||
    !SHA256_RE.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1
  ) {
    throw new Error(`flat Homebrew VFS ${label} identity is invalid`);
  }
  return { sha256: value.sha256, bytes: value.bytes };
}
