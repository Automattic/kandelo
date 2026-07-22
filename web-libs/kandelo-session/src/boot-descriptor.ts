// Boot-descriptor URL codec — the `k1` envelope.
//
// Real format per docs/plans/2026-05-11-shareable-computer-url-design.md:
//
//   #k1=base64url(zstd(cbor(payload)))
//
// This v0 implementation uses JSON + gzip (via CompressionStream) + base64url
// to avoid pulling in cbor-x and a zstd encoder. The envelope name (`k1`) is
// part of the version handshake — when we migrate to CBOR + zstd, the
// envelope name changes (`k2`) so old links keep parsing. The public API
// here doesn't change.
//
// Validation enforces the hard caps from the design doc's Security And Trust
// section. URLs are untrusted input; reject malformed or oversized payloads
// loudly rather than letting bad data flow into the boot path.

import type { BootDescriptor, MountSource, ShareMode } from "./kernel-host";

// ── Hard caps (from §Security And Trust + product judgement) ───────────────
//
// The design doc lists what to cap but not specific numbers. These defaults
// match the four-tier URL budget table (8KB shareable, 32KB power-user) and
// the prototype's behavior. Reviewers should treat each as load-bearing.

export const HARD_CAPS = {
  /** Max compressed payload size in bytes. Above this → manifest mode. */
  maxCompressedBytes: 64 * 1024,
  /** Max decompressed CBOR/JSON size. Defends decompression bombs. */
  maxDecompressedBytes: 1024 * 1024,
  /** Max mounts per descriptor. */
  maxMounts: 32,
  /** Max independently selected package layers. */
  maxPackageLayers: 8,
  /** Max UTF-8 byte length of any path string in mounts/boot.cwd. */
  maxPathLen: 1024,
  /** Max immutable package-layer descriptor size. */
  maxPackageLayerDescriptorBytes: 16 * 1024 * 1024,
  /** Max bytes for a single inline-overlay's `data` field. */
  maxInlineOverlayBytes: 32 * 1024,
  /** Allowed mount source kinds. */
  allowedMountSources: new Set<MountSource>([
    "image", "package-layer", "inline-overlay", "remote-overlay",
    "scratch", "opfs", "lazy-http", "archive", "git", "cas",
    "encrypted", "device",
  ]),
} as const;

const PACKAGE_LAYER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PACKAGE_LAYER_REF_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_PACKAGE_LAYER_URL_CHARS = 8192;

// ── Tier classification ────────────────────────────────────────────────────

export type UrlTier = "tiny" | "shareable" | "power-user" | "extended";

export function classifyTier(urlBytes: number): UrlTier {
  if (urlBytes <= 2 * 1024) return "tiny";
  if (urlBytes <= 8 * 1024) return "shareable";
  if (urlBytes <= 32 * 1024) return "power-user";
  return "extended";
}

// ── Base64url (no padding) ─────────────────────────────────────────────────

function base64urlEncode(bytes: Uint8Array): string {
  // btoa wants a binary string; build it without allocating a giant array.
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Gzip compression via CompressionStream (browser + modern Node) ─────────

async function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
  // CompressionStream is in Node 18+ and all modern browsers. We don't have
  // a pre-existing Node-only fallback here; if it's missing we throw — the
  // caller is expected to be a browser context where it's always available.
  if (typeof CompressionStream === "undefined") {
    throw new Error("CompressionStream is not available in this runtime");
  }
  const stream = new Blob([new Uint8Array(bytes)]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function gzipDecompress(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("DecompressionStream is not available in this runtime");
  }
  const stream = new Blob([new Uint8Array(bytes)]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(
        `decompressed payload exceeds cap of ${maxBytes} bytes — refusing to read further`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

// ── Validation ─────────────────────────────────────────────────────────────

export class BootDescriptorError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BootDescriptorError";
  }
}

function canonicalAbsolutePath(value: string): boolean {
  if (
    value.length === 0 ||
    !value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    (value.length > 1 && value.endsWith("/"))
  ) {
    return false;
  }
  if (value === "/") return true;
  return !value.slice(1).split("/").some(
    (component) => component === "" || component === "." || component === "..",
  );
}

function unauthenticatedHttpsUrl(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PACKAGE_LAYER_URL_CHARS) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === "";
  } catch {
    return false;
  }
}

/**
 * Throws if `desc` is missing required fields or violates a hard cap. The
 * structural check is conservative — unknown fields are tolerated (so we
 * can evolve the schema without breaking older clients) but unknown mount
 * sources or oversized data are rejected.
 */
export function validateBootDescriptor(desc: unknown): asserts desc is BootDescriptor {
  if (!desc || typeof desc !== "object") {
    throw new BootDescriptorError("E_NOT_OBJECT", "descriptor is not an object");
  }
  const d = desc as Record<string, unknown>;
  if (d.version !== 1) {
    throw new BootDescriptorError("E_VERSION", `unsupported descriptor version: ${String(d.version)}`);
  }
  for (const field of ["id", "title", "base"] as const) {
    if (typeof d[field] !== "string") {
      throw new BootDescriptorError("E_MISSING_FIELD", `${field} must be a string`);
    }
  }
  if (!d.runtime || typeof d.runtime !== "object") {
    throw new BootDescriptorError("E_MISSING_FIELD", "runtime must be an object");
  }
  if (!Array.isArray(d.packages)) {
    throw new BootDescriptorError("E_MISSING_FIELD", "packages must be an array");
  }
  if (!Array.isArray(d.mounts)) {
    throw new BootDescriptorError("E_MISSING_FIELD", "mounts must be an array");
  }
  if (d.mounts.length > HARD_CAPS.maxMounts) {
    throw new BootDescriptorError(
      "E_TOO_MANY_MOUNTS",
      `mount count ${d.mounts.length} exceeds cap of ${HARD_CAPS.maxMounts}`,
    );
  }
  const packageLayerNames = new Set<string>();
  const packageLayerRefs = new Set<string>();
  const packageLayerUrls = new Set<string>();
  const concreteMountPaths = new Set<string>();
  let packageLayerCount = 0;
  let packageLayerDescriptorBytes = 0;
  let hasRootImage = false;
  for (const [index, value] of (d.mounts as unknown[]).entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BootDescriptorError(
        "E_MOUNT_OBJECT",
        `mount ${index} must be an object`,
      );
    }
    const m = value as Record<string, unknown>;
    if (typeof m.path !== "string") {
      throw new BootDescriptorError("E_MOUNT_PATH", "mount.path must be a string");
    }
    if (new TextEncoder().encode(m.path).byteLength > HARD_CAPS.maxPathLen) {
      throw new BootDescriptorError(
        "E_PATH_TOO_LONG",
        `mount.path exceeds ${HARD_CAPS.maxPathLen} bytes: ${m.path.slice(0, 40)}…`,
      );
    }
    if (!canonicalAbsolutePath(m.path)) {
      throw new BootDescriptorError(
        "E_MOUNT_PATH",
        `mount.path must be a canonical absolute POSIX path: ${JSON.stringify(m.path)}`,
      );
    }
    if (typeof m.source !== "string" || !HARD_CAPS.allowedMountSources.has(m.source as MountSource)) {
      throw new BootDescriptorError(
        "E_MOUNT_SOURCE",
        `unknown mount.source: ${String(m.source)}`,
      );
    }
    if (m.source !== "package-layer") {
      if (concreteMountPaths.has(m.path)) {
        throw new BootDescriptorError(
          "E_DUPLICATE_MOUNT_PATH",
          `multiple concrete mounts target ${m.path}`,
        );
      }
      concreteMountPaths.add(m.path);
    }
    if (m.source === "image" && m.path === "/") hasRootImage = true;
    if (m.source === "package-layer") {
      packageLayerCount += 1;
      if (packageLayerCount > HARD_CAPS.maxPackageLayers) {
        throw new BootDescriptorError(
          "E_TOO_MANY_PACKAGE_LAYERS",
          `package-layer count exceeds cap of ${HARD_CAPS.maxPackageLayers}`,
        );
      }
      const keys = Object.keys(m).sort();
      const expected = ["bytes", "name", "path", "ref", "source", "url"];
      if (JSON.stringify(keys) !== JSON.stringify(expected)) {
        throw new BootDescriptorError(
          "E_PACKAGE_LAYER_FIELDS",
          `package-layer mount ${index} has unexpected or missing fields`,
        );
      }
      if (m.path !== "/") {
        throw new BootDescriptorError(
          "E_PACKAGE_LAYER_PATH",
          "package-layer mounts currently require path /",
        );
      }
      if (typeof m.name !== "string" || !PACKAGE_LAYER_NAME_RE.test(m.name)) {
        throw new BootDescriptorError(
          "E_PACKAGE_LAYER_NAME",
          `package-layer mount ${index} has an invalid name`,
        );
      }
      if (typeof m.ref !== "string" || !PACKAGE_LAYER_REF_RE.test(m.ref)) {
        throw new BootDescriptorError(
          "E_PACKAGE_LAYER_REF",
          `package-layer mount ${index} requires a lowercase sha256: ref`,
        );
      }
      if (typeof m.url !== "string" || !unauthenticatedHttpsUrl(m.url)) {
        throw new BootDescriptorError(
          "E_PACKAGE_LAYER_URL",
          `package-layer mount ${index} requires an unauthenticated HTTPS URL without a fragment`,
        );
      }
      if (
        !Number.isSafeInteger(m.bytes) ||
        Number(m.bytes) <= 0 ||
        Number(m.bytes) > HARD_CAPS.maxPackageLayerDescriptorBytes
      ) {
        throw new BootDescriptorError(
          "E_PACKAGE_LAYER_BYTES",
          `package-layer mount ${index} bytes must be between 1 and ` +
            `${HARD_CAPS.maxPackageLayerDescriptorBytes}`,
        );
      }
      packageLayerDescriptorBytes += Number(m.bytes);
      if (packageLayerDescriptorBytes > HARD_CAPS.maxPackageLayerDescriptorBytes) {
        throw new BootDescriptorError(
          "E_PACKAGE_LAYER_TOTAL_BYTES",
          `selected package-layer descriptors exceed the aggregate cap of ` +
            `${HARD_CAPS.maxPackageLayerDescriptorBytes} bytes`,
        );
      }
      if (
        packageLayerNames.has(m.name) ||
        packageLayerRefs.has(m.ref) ||
        packageLayerUrls.has(m.url)
      ) {
        throw new BootDescriptorError(
          "E_DUPLICATE_PACKAGE_LAYER",
          `package-layer mount ${index} duplicates another layer identity`,
        );
      }
      packageLayerNames.add(m.name);
      packageLayerRefs.add(m.ref);
      packageLayerUrls.add(m.url);
    }
    if (m.source === "inline-overlay" && typeof m.data === "string") {
      if (m.data.length > HARD_CAPS.maxInlineOverlayBytes) {
        throw new BootDescriptorError(
          "E_OVERLAY_TOO_LARGE",
          `inline-overlay.data exceeds cap of ${HARD_CAPS.maxInlineOverlayBytes} bytes`,
        );
      }
    }
  }
  if (packageLayerCount > 0 && !hasRootImage) {
    throw new BootDescriptorError(
      "E_PACKAGE_LAYER_BASE",
      "package-layer mounts require a root image mount",
    );
  }
  if (!d.boot || typeof d.boot !== "object") {
    throw new BootDescriptorError("E_MISSING_FIELD", "boot must be an object");
  }
  const boot = d.boot as Record<string, unknown>;
  if (!Array.isArray(boot.argv) || boot.argv.length === 0) {
    throw new BootDescriptorError("E_BOOT_ARGV", "boot.argv must be a non-empty array");
  }
  if (typeof boot.cwd !== "string") {
    throw new BootDescriptorError("E_BOOT_CWD", "boot.cwd must be a string");
  }
  if (
    new TextEncoder().encode(boot.cwd).byteLength > HARD_CAPS.maxPathLen ||
    !canonicalAbsolutePath(boot.cwd)
  ) {
    throw new BootDescriptorError(
      "E_BOOT_CWD",
      "boot.cwd must be a bounded canonical absolute POSIX path",
    );
  }
  if (!boot.env || typeof boot.env !== "object") {
    throw new BootDescriptorError("E_BOOT_ENV", "boot.env must be an object");
  }
  for (const field of ["uid", "gid"] as const) {
    if (
      boot[field] !== undefined &&
      (!Number.isInteger(boot[field]) || (boot[field] as number) < 0 || (boot[field] as number) > 0xffff)
    ) {
      throw new BootDescriptorError("E_BOOT_USER", `boot.${field} must be an integer from 0 to 65535`);
    }
  }
}

// ── Encode / decode ────────────────────────────────────────────────────────

export interface EncodedDescriptor {
  /** "k1=…" — drop into the URL fragment after the "#". */
  fragment: string;
  /** byte length of `fragment` (the k1=… prefix included). */
  urlBytes: number;
  /** byte length of the inner payload after compression. */
  payloadBytes: number;
}

/**
 * Encode a BootDescriptor as a `k1=` URL fragment. Throws on cap violation.
 */
export async function encodeBootDescriptor(
  descriptor: BootDescriptor,
): Promise<EncodedDescriptor> {
  validateBootDescriptor(descriptor);
  const json = new TextEncoder().encode(JSON.stringify(descriptor));
  const compressed = await gzipCompress(json);
  if (compressed.byteLength > HARD_CAPS.maxCompressedBytes) {
    throw new BootDescriptorError(
      "E_PAYLOAD_TOO_LARGE",
      `compressed payload ${compressed.byteLength} B exceeds cap of ${HARD_CAPS.maxCompressedBytes} B; use a manifest mode`,
    );
  }
  const fragment = "k1=" + base64urlEncode(compressed);
  return {
    fragment,
    urlBytes: fragment.length,
    payloadBytes: compressed.byteLength,
  };
}

/**
 * Decode a `k1=…` fragment back into a validated BootDescriptor. The leading
 * "#" is optional. Returns null if the fragment is not a `k1=` envelope (so
 * callers can fall through to other parsers). Throws BootDescriptorError if
 * the envelope is valid but the payload is malformed or oversized.
 */
export async function decodeBootDescriptor(fragment: string): Promise<BootDescriptor | null> {
  const match = /^#?k1=([^#&]+)/.exec(fragment.trim());
  if (!match) return null;
  const raw = base64urlDecode(match[1]);
  if (raw.byteLength > HARD_CAPS.maxCompressedBytes) {
    throw new BootDescriptorError(
      "E_PAYLOAD_TOO_LARGE",
      `compressed payload exceeds cap of ${HARD_CAPS.maxCompressedBytes} bytes`,
    );
  }
  const decompressed = await gzipDecompress(raw, HARD_CAPS.maxDecompressedBytes);
  const text = new TextDecoder().decode(decompressed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BootDescriptorError(
      "E_BAD_JSON",
      `decoded payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  validateBootDescriptor(parsed);
  return parsed;
}

// ── URL builder ────────────────────────────────────────────────────────────

export interface BuildShareUrlOptions {
  host?: string;
  mode?: ShareMode;
  /** Encoded fragment body (e.g. `"k1=…"`) for delta/inline modes. */
  fragment?: string;
  /** Preset id to embed in the URL path. Falls back to descriptor.id. */
  presetId?: string;
  /** Decryption key (base64url) for private mode. Goes in the fragment. */
  encryptionKeyFragment?: string;
}

export function buildShareUrl(
  descriptor: BootDescriptor,
  opts: BuildShareUrlOptions = {},
): string {
  const host = opts.host ?? "kandelo.dev";
  const mode = opts.mode ?? "preset";
  const pid = opts.presetId || descriptor.id || "machine";
  switch (mode) {
    case "preset":
      return `https://${host}/c/${pid}`;
    case "manifest":
      return `https://${host}/m/${descriptor.id}-${shortHash(descriptor)}`;
    case "private": {
      const key = opts.encryptionKeyFragment ?? "";
      return `https://${host}/p/${shortHash(descriptor)}#${key}`;
    }
    case "local":
      return `https://${host}/local/${pid}`;
    case "inline":
    case "delta":
    case "auto":
    case "recipe":
    case "replay":
    case "live":
    default: {
      const frag = opts.fragment ?? "";
      return frag
        ? `https://${host}/c/${pid}#${frag}`
        : `https://${host}/c/${pid}`;
    }
  }
}

// ── Display hash (NOT cryptographic) ───────────────────────────────────────
//
// Used by the Share dialog's "what's in this link" preview and by manifest
// URLs as a human-recognizable handle. Real manifest mode uploads to a
// content-addressed registry; this is the short-id alongside the upload's
// sha256.

export function shortHash(obj: unknown): string {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h2 = Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h1 ^= h2 >>> 16;
  h2 ^= h1 >>> 16;
  return (h1 >>> 0).toString(16).padStart(8, "0")
       + (h2 >>> 0).toString(16).padStart(8, "0");
}

// ── Share-mode display metadata ────────────────────────────────────────────

export const SHARE_MODE_INFO: Record<ShareMode, { label: string; blurb: string }> = {
  preset:   { label: "Preset",   blurb: "Named base + packages + boot command. No user state." },
  inline:   { label: "Inline",   blurb: "Full computer state encoded in the URL." },
  delta:    { label: "Delta",    blurb: "Signed base + tiny inline overlay of your changes." },
  manifest: { label: "Manifest", blurb: "URL is a hash; full descriptor fetched at runtime." },
  private:  { label: "Private",  blurb: "Ciphertext on the server; decryption key in the fragment." },
  local:    { label: "Local",    blurb: "Points at an OPFS workspace — only works in this browser." },
  recipe:   { label: "Recipe",   blurb: "Reconstructed from package selections + setup commands." },
  replay:   { label: "Replay",   blurb: "Clean base + replay of your command transcript." },
  live:     { label: "Live",     blurb: "Connects to a collaborative or server-backed source." },
  auto:     { label: "Auto",     blurb: "Kandelo picks the smallest viable mode." },
};
