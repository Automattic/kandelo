// Boot inputs — named, sha256-verified, URL-carried files materialized into
// the guest VFS before the initial process starts.
//
// A `BootDescriptor.boot.inputs` entry declares an id, a safe filename, an
// exact byte length, and a lowercase sha256 of the final bytes, plus one of
// two sources: `inline` (bytes physically carried in the descriptor, bounded
// by HARD_CAPS.maxInlineInputBytes) or `resolver` (a host-registered resolver
// name plus a JSON-safe locator; resolver implementations are host policy and
// are never supplied by the URL itself).
//
// `materializeBootInputs` resolves every declared input, verifies its byte
// length and sha256 against what the descriptor claims, and only then writes
// anything to the guest VFS. No partial writes: if any input fails
// verification, the VFS is untouched. The successfully materialized set is
// recorded at KANDELO_BOOT_INPUT_MANIFEST_PATH so guest-side consumers (e.g. a
// boot-link script) can discover what was staged and under `boot.parameters`
// values were passed.
//
// Ported from the `emdash/consider-video-game-emulators-3ksig` prototype.
// That branch gated `boot.inputs`/`boot.parameters` behind a version-2
// descriptor; this branch has no shipped v2 links to preserve compatibility
// for, so the maintainer waived the version bump and these fields are simply
// optional on version 1 (see docs/superpowers/plans/2026-09-21-boot-inputs-
// fold-in.md). The manifest therefore has no `descriptorVersion` field, and
// materialized files are written mode 0o755 rather than the prototype's
// 0o444 — the maintainer wants staged files (in particular a boot-link
// script) left writable for in-place experimentation, matching the existing
// `/tmp/kandelo-link.sh` behavior this replaces.

import {
  HARD_CAPS,
  BootDescriptorError,
  validateBootDescriptor,
} from "./boot-descriptor";
import type {
  BootDescriptor,
  BootInput,
  BootJsonValue,
  BootParameters,
} from "./kernel-host";

export const KANDELO_BOOT_INPUT_DIR = "/run/kandelo/inputs";
export const KANDELO_BOOT_INPUT_MANIFEST_PATH = "/run/kandelo/boot-input.json";

/** Materialized files are left writable for in-place experimentation. */
const MATERIALIZED_FILE_MODE = 0o755;
/** The manifest is JSON content, not an executable; it never needs 0o755. */
const MANIFEST_FILE_MODE = 0o644;

export interface BootInputResolverContext {
  input: BootInput;
  signal?: AbortSignal;
}

export type BootInputResolver = (
  locator: BootJsonValue,
  context: BootInputResolverContext,
) => Promise<Uint8Array | ArrayBuffer>;

export type BootInputResolverRegistry =
  | ReadonlyMap<string, BootInputResolver>
  | Readonly<Record<string, BootInputResolver>>;

export interface MaterializedBootInput {
  id: string;
  filename: string;
  path: string;
  mediaType?: string;
  byteLength: number;
  sha256: string;
}

export interface BootInputManifest {
  version: 1;
  parameters: BootParameters;
  inputs: MaterializedBootInput[];
}

export interface MaterializeBootInputsOptions {
  /** Resolver implementations are host policy, never supplied by the URL. */
  resolvers?: BootInputResolverRegistry;
  /** Ensure a guest directory exists. Implementations may treat EEXIST as success. */
  mkdir(path: string, mode: number): void | Promise<void>;
  /** Write one complete guest file. Called only after every input verifies. */
  writeFile(path: string, bytes: Uint8Array, mode: number): void | Promise<void>;
  signal?: AbortSignal;
  /** Test/embedder seam; defaults to Web Crypto in browsers and modern Node.js. */
  sha256?: (bytes: Uint8Array) => Promise<string>;
}

interface VerifiedInput {
  manifest: MaterializedBootInput;
  bytes: Uint8Array;
}

export interface CreateInlineBootInputOptions {
  id: string;
  filename: string;
  mediaType?: string;
  bytes: Uint8Array;
  /** Compress transport bytes while preserving size/hash over the final file. */
  compression?: "gzip";
}

/**
 * Build one content-addressed inline input from browser/Node-owned bytes.
 * The returned source remains bounded by the URL transport cap; gzip inputs
 * are decompressed and verified before materialization touches the guest VFS.
 */
export async function createInlineBootInput(
  options: CreateInlineBootInputOptions,
): Promise<BootInput> {
  if (options.compression !== undefined && options.compression !== "gzip") {
    throw new BootDescriptorError(
      "E_INLINE_COMPRESSION",
      "inline input compression must be gzip when present",
    );
  }
  if (options.bytes.byteLength > HARD_CAPS.maxInlineInflatedInputBytes) {
    throw new BootDescriptorError(
      "E_INLINE_TOO_LARGE",
      `inline input exceeds inflated cap of ${HARD_CAPS.maxInlineInflatedInputBytes} bytes`,
    );
  }
  const bytes = copyBytes(options.bytes);
  const carried = options.compression === "gzip"
    ? await gzipCompress(bytes)
    : bytes;
  if (carried.byteLength > HARD_CAPS.maxInlineInputBytes) {
    throw new BootDescriptorError(
      "E_INLINE_TOO_LARGE",
      `inline input carries ${carried.byteLength} bytes; cap is ${HARD_CAPS.maxInlineInputBytes}`,
    );
  }
  return {
    id: options.id,
    filename: options.filename,
    ...(options.mediaType ? { mediaType: options.mediaType } : {}),
    byteLength: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    source: {
      kind: "inline",
      data: base64urlEncode(carried),
      ...(options.compression ? { compression: options.compression } : {}),
    },
  };
}

/**
 * Resolve and verify every declared boot input, then materialize the
 * complete set and its well-known manifest. No filesystem callback is
 * invoked until all declared byte lengths and SHA-256 digests have matched.
 */
export async function materializeBootInputs(
  descriptor: BootDescriptor,
  options: MaterializeBootInputsOptions,
): Promise<BootInputManifest> {
  validateBootDescriptor(descriptor);

  const verified: VerifiedInput[] = [];
  const inputs = descriptor.boot.inputs ?? [];
  for (const input of inputs) {
    throwIfAborted(options.signal);
    const bytes = input.source.kind === "inline"
      ? await materializeInlineBytes(input, options.signal)
      : await resolveInput(input, options.resolvers, options.signal);
    const ownedBytes = copyBytes(bytes);
    if (ownedBytes.byteLength !== input.byteLength) {
      throw new BootDescriptorError(
        "E_INPUT_SIZE_MISMATCH",
        `${input.id} expected ${input.byteLength} bytes but resolved ${ownedBytes.byteLength}`,
      );
    }
    const digest = await (options.sha256 ?? sha256Hex)(ownedBytes);
    if (digest !== input.sha256) {
      throw new BootDescriptorError(
        "E_INPUT_HASH_MISMATCH",
        `${input.id} sha256 mismatch: expected ${input.sha256}, got ${digest}`,
      );
    }
    verified.push({
      bytes: ownedBytes,
      manifest: {
        id: input.id,
        filename: input.filename,
        path: `${KANDELO_BOOT_INPUT_DIR}/${input.id}/${input.filename}`,
        ...(input.mediaType ? { mediaType: input.mediaType } : {}),
        byteLength: input.byteLength,
        sha256: input.sha256,
      },
    });
  }

  throwIfAborted(options.signal);
  const manifest: BootInputManifest = {
    version: 1,
    parameters: cloneJsonObject(descriptor.boot.parameters ?? {}),
    inputs: verified.map((entry) => ({ ...entry.manifest })),
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

  // This is the first point at which filesystem state may change.
  await options.mkdir("/run", 0o755);
  await options.mkdir("/run/kandelo", 0o755);
  await options.mkdir(KANDELO_BOOT_INPUT_DIR, 0o755);
  for (const entry of verified) {
    throwIfAborted(options.signal);
    await options.mkdir(`${KANDELO_BOOT_INPUT_DIR}/${entry.manifest.id}`, 0o755);
    await options.writeFile(entry.manifest.path, entry.bytes, MATERIALIZED_FILE_MODE);
  }
  throwIfAborted(options.signal);
  await options.writeFile(KANDELO_BOOT_INPUT_MANIFEST_PATH, manifestBytes, MANIFEST_FILE_MODE);
  return manifest;
}

async function resolveInput(
  input: BootInput,
  registry: BootInputResolverRegistry | undefined,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (input.source.kind !== "resolver") {
    throw new BootDescriptorError("E_INPUT_SOURCE", `${input.id} has no resolver source`);
  }
  const resolver = resolverFromRegistry(registry, input.source.resolver);
  if (!resolver) {
    throw new BootDescriptorError(
      "E_INPUT_RESOLVER_UNAVAILABLE",
      `boot input resolver is unavailable: ${input.source.resolver}`,
    );
  }
  const result = await resolver(input.source.locator, { input, signal });
  throwIfAborted(signal);
  if (result instanceof Uint8Array) return result;
  if (result instanceof ArrayBuffer) return new Uint8Array(result);
  throw new BootDescriptorError(
    "E_INPUT_RESOLVER_RESULT",
    `${input.source.resolver} returned neither Uint8Array nor ArrayBuffer`,
  );
}

function resolverFromRegistry(
  registry: BootInputResolverRegistry | undefined,
  name: string,
): BootInputResolver | undefined {
  if (!registry) return undefined;
  if (registry instanceof Map) return registry.get(name);
  const record = registry as Readonly<Record<string, BootInputResolver>>;
  return Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > HARD_CAPS.maxInputBytes) {
    throw new BootDescriptorError(
      "E_INPUT_SIZE_MISMATCH",
      `resolved input exceeds ${HARD_CAPS.maxInputBytes} bytes`,
    );
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

async function materializeInlineBytes(
  input: BootInput,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (input.source.kind !== "inline") {
    throw new BootDescriptorError("E_INPUT_SOURCE", `${input.id} is not inline`);
  }
  throwIfAborted(signal);
  const carried = decodeCanonicalBase64Url(input.source.data);
  if (input.source.compression !== "gzip") return carried;
  return gzipDecompress(carried, input.byteLength, input.id, signal);
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new BootDescriptorError("E_INLINE_ENCODING", "inline input is not unpadded base64url");
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const output = new Uint8Array(Math.floor((value.length * 6) / 8));
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) {
      throw new BootDescriptorError("E_INLINE_ENCODING", "inline input is not base64url");
    }
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (accumulator >>> bits) & 0xff;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && accumulator !== 0) {
    throw new BootDescriptorError(
      "E_INLINE_ENCODING",
      "inline input has non-canonical base64url padding bits",
    );
  }
  return output;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new BootDescriptorError("E_CRYPTO_UNAVAILABLE", "Web Crypto SHA-256 is unavailable");
  }
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", owned.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset++) {
    binary += String.fromCharCode(bytes[offset]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") {
    throw new BootDescriptorError(
      "E_COMPRESSION_UNAVAILABLE",
      "CompressionStream gzip is unavailable",
    );
  }
  const stream = new Blob([Uint8Array.from(bytes)]).stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gzipDecompress(
  bytes: Uint8Array,
  expectedBytes: number,
  inputId: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new BootDescriptorError(
      "E_COMPRESSION_UNAVAILABLE",
      "DecompressionStream gzip is unavailable",
    );
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const cancelForAbort = () => {
    if (reader) {
      void reader.cancel("boot input materialization was aborted").catch(() => {});
    }
  };
  try {
    const stream = new Blob([Uint8Array.from(bytes)]).stream()
      .pipeThrough(new DecompressionStream("gzip"));
    reader = stream.getReader();
    signal?.addEventListener("abort", cancelForAbort, { once: true });
    if (signal?.aborted) cancelForAbort();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedBytes || total > HARD_CAPS.maxInlineInflatedInputBytes) {
        await reader.cancel("gzip output exceeded its declared boundary");
        throw new BootDescriptorError(
          "E_INPUT_SIZE_MISMATCH",
          `${inputId} gzip output exceeds declared ${expectedBytes} bytes`,
        );
      }
      chunks.push(Uint8Array.from(value));
    }
    throwIfAborted(signal);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } catch (reason) {
    if (reason instanceof BootDescriptorError) throw reason;
    throwIfAborted(signal);
    throw new BootDescriptorError(
      "E_INLINE_COMPRESSION",
      `${inputId} gzip payload could not be decompressed: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
  } finally {
    signal?.removeEventListener("abort", cancelForAbort);
    reader?.releaseLock();
  }
}

function cloneJsonObject(value: BootParameters): BootParameters {
  return JSON.parse(JSON.stringify(value)) as BootParameters;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("boot input materialization was aborted");
  error.name = "AbortError";
  throw error;
}
