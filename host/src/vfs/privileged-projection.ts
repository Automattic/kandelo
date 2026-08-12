import { OPEN_FLAGS } from "../generated/abi";
import type { FileSystemBackend, MountConfig } from "./types";
import { ensureDirRecursive, writeVfsBinary } from "./image-helpers";
import {
  captureMemoryFileSystemInodeIdentity,
  createFreshMemoryFileSystem,
  createImmutableProductBackend,
  MemoryFileSystem,
  resolveMountSetIdCapability,
  type MemoryFileSystemInodeIdentity,
} from "./memory-fs";

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const MODE_BITS = 0o7777;
const SHA256_RE = /^[0-9a-f]{64}$/;
const PRODUCT_DESTINATIONS = [
  "/usr/bin/login",
  "/usr/bin/sudo-lite",
  "/usr/bin/sudo",
] as const;
const PRODUCT_DESTINATION_SET = new Set<string>(PRODUCT_DESTINATIONS);
const PROJECTION_KEYS = [
  "schema",
  "formula",
  "bottleSha256",
  "sourcePath",
  "destinationPath",
  "uid",
  "gid",
  "mode",
  "mountPoint",
  "artifactValidationSha256",
] as const;
const PROJECTION_KEY_SET = new Set<string>(PROJECTION_KEYS);
const MIN_PRODUCT_CAPACITY = 4 * 1024 * 1024;
const MAX_PROGRAM_BYTES = 64 * 1024 * 1024;
const MAX_PRODUCT_BYTES = 128 * 1024 * 1024;
const intrinsicHasOwnProperty = Object.prototype.hasOwnProperty;
const reviewedPolicies = new WeakMap<object, PrivilegedProgramProjection[]>();
const privatelyStagedCandidates = new WeakSet<MemoryFileSystem>();
const publishedProductBrowserMounts = new WeakMap<
  object,
  PublishedPrivilegedProgramBrowserMount
>();
const publishedProductProjections = new WeakMap<
  object,
  PrivilegedProgramProjection[]
>();

export interface PrivilegedProgramProjection {
  schema: 1;
  formula: string;
  bottleSha256: string;
  sourcePath: string;
  destinationPath: string;
  uid: 0;
  gid: 0;
  mode: number;
  mountPoint: string;
  artifactValidationSha256: string;
}

/** Opaque authority for one product-owned, reviewed projection policy. */
export interface ReviewedPrivilegedProgramPolicy {
  readonly kind: "kandelo-reviewed-privileged-program-policy";
}

export interface PrivilegedProgramSourceInventoryEntry {
  sourcePath: string;
  type: "directory" | "file" | "symlink" | "hardlink";
  size: number;
  target?: string;
}

export interface PrivilegedProgramSource {
  formula: string;
  bottleSha256: string;
  fs: MemoryFileSystem;
  inventory: {
    entries: readonly PrivilegedProgramSourceInventoryEntry[];
  };
  guestPathForSource(sourcePath: string): string;
}

export interface PrivilegedProgramPublicationEvidence {
  sourcePath: string;
  canonicalSourcePath: string;
  destinationPath: string;
  sourceIdentity: MemoryFileSystemInodeIdentity;
  destinationIdentity: MemoryFileSystemInodeIdentity;
  collidesWithWritableBottle: false;
}

export interface PublishedPrivilegedProgramProduct {
  projections: PrivilegedProgramProjection[];
  evidence: PrivilegedProgramPublicationEvidence[];
  mount: MountConfig;
  /** Serialized independent tree for build-time artifact publication. */
  imageBytes: Uint8Array;
}

export interface PublishedPrivilegedProgramBrowserMount {
  mountPoint: "/usr/bin";
  imageBytes: Uint8Array;
}

export interface PublishPrivilegedProgramProductOptions {
  policy: ReviewedPrivilegedProgramPolicy;
  sources: readonly PrivilegedProgramSource[];
  writableBottleFileSystems: readonly MemoryFileSystem[];
}

export interface ValidatePrivilegedProgramProductCandidateOptions
  extends PublishPrivilegedProgramProductOptions {
  candidateFs: MemoryFileSystem;
}

interface AuthenticatedProgramSource {
  projection: PrivilegedProgramProjection;
  source: PrivilegedProgramSource;
  canonicalSourcePath: string;
  guestPath: string;
  bytes: Uint8Array;
  identity: MemoryFileSystemInodeIdentity;
}

/** Parse the complete, closed set of reviewed system-program projections. */
export function parsePrivilegedProgramProjections(
  value: unknown,
): PrivilegedProgramProjection[] {
  if (!Array.isArray(value) || value.length !== PRODUCT_DESTINATIONS.length) {
    throw new Error(
      `privileged projection group must contain exactly ${PRODUCT_DESTINATIONS.length} entries`,
    );
  }

  const destinations = new Set<string>();
  const parsed = value.map((entry, index) => {
    const record = exactRecord(entry, `privileged projection ${index}`);
    const unknownKeys = Object.keys(record).filter((key) =>
      !PROJECTION_KEY_SET.has(key)
    );
    const missingKeys = PROJECTION_KEYS.filter((key) =>
      !Reflect.apply(intrinsicHasOwnProperty, record, [key])
    );
    if (unknownKeys.length !== 0 || missingKeys.length !== 0) {
      throw new Error(
        `privileged projection ${index} must use the closed schema`,
      );
    }
    if (record.schema !== 1) {
      throw new Error(`privileged projection ${index} has unsupported schema`);
    }
    const formula = requireNonemptyString(record.formula, "projection formula");
    const bottleSha256 = requireSha256(
      record.bottleSha256,
      "projection bottle digest",
    );
    const sourcePath = requireCanonicalSourcePath(
      record.sourcePath,
      "projection source path",
    );
    const destinationPath = requireNonemptyString(
      record.destinationPath,
      "projection destination path",
    );
    if (!PRODUCT_DESTINATION_SET.has(destinationPath)) {
      throw new Error(
        `privileged projection destination is not reviewed: ${destinationPath}`,
      );
    }
    if (destinations.has(destinationPath)) {
      throw new Error(
        `privileged projection has duplicate destination ${destinationPath}`,
      );
    }
    destinations.add(destinationPath);
    if (record.uid !== 0 || record.gid !== 0) {
      throw new Error("privileged projection must be owned by uid 0 and gid 0");
    }
    if (record.mode !== 0o4755) {
      throw new Error("privileged projection mode must be 04755");
    }
    if (record.mountPoint !== "trusted-root-product") {
      throw new Error("privileged projection mount is not recognized");
    }
    const artifactValidationSha256 = requireSha256(
      record.artifactValidationSha256,
      "projection artifact validation digest",
    );
    return {
      schema: 1,
      formula,
      bottleSha256,
      sourcePath,
      destinationPath,
      uid: 0,
      gid: 0,
      mode: 0o4755,
      mountPoint: "trusted-root-product",
      artifactValidationSha256,
    } satisfies PrivilegedProgramProjection;
  });

  for (const destination of PRODUCT_DESTINATIONS) {
    if (!destinations.has(destination)) {
      throw new Error(`privileged projection group is missing ${destination}`);
    }
  }
  return parsed;
}

/**
 * Mint reviewed policy authority at a product-owned build/code boundary.
 * This factory is deliberately absent from every public host/browser barrel.
 */
export function createReviewedPrivilegedProgramPolicy(
  value: unknown,
): ReviewedPrivilegedProgramPolicy {
  const projections = parsePrivilegedProgramProjections(value);
  const policy = Object.freeze({
    kind: "kandelo-reviewed-privileged-program-policy" as const,
  });
  reviewedPolicies.set(policy, projections);
  return policy;
}

/** Read a branded policy without accepting a structurally similar object. */
export function readReviewedPrivilegedProgramPolicy(
  policy: ReviewedPrivilegedProgramPolicy,
): PrivilegedProgramProjection[] {
  const projections = reviewedPolicies.get(policy);
  if (projections === undefined) {
    throw new Error("privileged program policy lacks product review authority");
  }
  return projections.map((projection) => ({ ...projection }));
}

/**
 * Snapshot the serialized tree of a product admitted by this publisher.
 *
 * BrowserKernel uses this private-module boundary before it sends trusted-root
 * authority to its owning worker. A structurally similar object, or mutation
 * of the public build artifact bytes after publication, cannot mint a trusted
 * browser mount.
 */
export function snapshotPublishedPrivilegedProgramBrowserMount(
  product: PublishedPrivilegedProgramProduct,
): PublishedPrivilegedProgramBrowserMount {
  const mount = publishedProductBrowserMounts.get(product);
  if (mount === undefined) {
    throw new Error("privileged program product lacks publication authority");
  }
  return {
    mountPoint: mount.mountPoint,
    imageBytes: mount.imageBytes.slice(),
  };
}

/**
 * Compare a writable image file with the exact projection admitted for a
 * privately branded product. This conveys no mount capability and is absent
 * from public barrels; browser product loaders use it to reject stale staged
 * destinations before granting a terminal policy.
 */
export async function publishedPrivilegedProgramMatchesFile(
  product: PublishedPrivilegedProgramProduct,
  fs: MemoryFileSystem,
  destinationPath: string,
): Promise<boolean> {
  const projections = publishedProductProjections.get(product);
  if (projections === undefined) {
    throw new Error("privileged program product lacks publication authority");
  }
  const matching = projections.filter(
    (projection) => projection.destinationPath === destinationPath,
  );
  if (matching.length !== 1) return false;
  try {
    return await sha256Hex(readRegularFile(fs, destinationPath)) ===
      matching[0]!.artifactValidationSha256;
  } catch {
    return false;
  }
}

/**
 * Copy all reviewed members into one unpublished tree, then admit the group.
 * A failed member leaves no returned backend and never mutates a bottle tree.
 */
export async function publishPrivilegedProgramProduct(
  options: PublishPrivilegedProgramProductOptions,
): Promise<PublishedPrivilegedProgramProduct> {
  const projections = readReviewedPrivilegedProgramPolicy(options.policy);
  const authenticated = await authenticateProgramSources(
    projections,
    options.sources,
  );
  const productBytes = authenticated.reduce(
    (sum, source) => sum + source.bytes.byteLength,
    0,
  );
  if (productBytes > MAX_PRODUCT_BYTES) {
    throw new Error("privileged projection group exceeds the product byte limit");
  }
  const capacity = Math.max(
    MIN_PRODUCT_CAPACITY,
    productBytes + 2 * 1024 * 1024,
  );
  const candidateFs = createFreshMemoryFileSystem(capacity);
  privatelyStagedCandidates.add(candidateFs);
  initializeProductTree(candidateFs);

  for (const entry of authenticated) {
    writeVfsBinary(
      candidateFs,
      entry.projection.destinationPath,
      entry.bytes,
      0o755,
    );
    // chown clears set-ID bits by design, so ownership precedes final mode.
    candidateFs.chown(entry.projection.destinationPath, 0, 0);
    candidateFs.chmod(entry.projection.destinationPath, 0o4755);
  }

  return publishAuthenticatedCandidate({
    ...options,
    candidateFs,
    projections,
    authenticated,
  });
}

/**
 * Validate caller-owned candidate invariants without publishing authority.
 *
 * This path never stages the candidate, snapshots or brands a backend,
 * resolves a mount capability, or returns a publication object.
 */
export async function validatePrivilegedProgramProductCandidate(
  options: ValidatePrivilegedProgramProductCandidateOptions,
): Promise<void> {
  const projections = readReviewedPrivilegedProgramPolicy(options.policy);
  const authenticated = await authenticateProgramSources(
    projections,
    options.sources,
  );
  validateAuthenticatedCandidate({
    ...options,
    projections,
    authenticated,
  });
}

interface AuthenticatedCandidateOptions {
  candidateFs: MemoryFileSystem;
  writableBottleFileSystems: readonly MemoryFileSystem[];
  projections: PrivilegedProgramProjection[];
  authenticated: AuthenticatedProgramSource[];
}

async function publishAuthenticatedCandidate(
  options: AuthenticatedCandidateOptions,
): Promise<PublishedPrivilegedProgramProduct> {
  consumePrivatelyStagedCandidate(options.candidateFs);
  const evidence = validateAuthenticatedCandidate(options);
  // Snapshot immediately after the synchronous identity checks. All later
  // authentication reads come from Task 6's isolated immutable copy, so a
  // retained MemoryFS wrapper cannot race digest validation and publication.
  const backend = createImmutableProductBackend(options.candidateFs);
  await validateImmutableProductBackend(backend, options.authenticated);
  const imageBytes = await serializeImmutableProduct(
    backend,
    options.authenticated,
  );
  const browserMountImageBytes = await serializeImmutableBrowserMount(
    backend,
    options.authenticated,
  );
  // WHY: the projection record's mountPoint is a policy identity, not mount
  // authority. Only Task 6's private backend brand plus this resolved mount
  // capability can authorize the trusted product tree.
  const mount: MountConfig = {
    mountPoint: "/",
    backend,
    readonly: true,
    setIdCapability: {
      kind: "trusted-root-product",
      guestWritable: false,
      stableExecutableIdentity: true,
    },
  };
  resolveMountSetIdCapability(mount);
  const product: PublishedPrivilegedProgramProduct = {
    projections: options.projections.map((projection) => ({ ...projection })),
    evidence,
    mount,
    imageBytes: imageBytes.slice(),
  };
  publishedProductBrowserMounts.set(product, {
    mountPoint: "/usr/bin",
    imageBytes: browserMountImageBytes,
  });
  publishedProductProjections.set(
    product,
    options.projections.map((projection) => ({ ...projection })),
  );
  return product;
}

function validateAuthenticatedCandidate(
  options: AuthenticatedCandidateOptions,
): PrivilegedProgramPublicationEvidence[] {
  assertSecureProductParents(options.candidateFs);
  const writableIdentities = collectTreeIdentityKeys(
    options.writableBottleFileSystems,
  );
  const destinationIdentities = new Set<string>();
  const evidence: PrivilegedProgramPublicationEvidence[] = [];

  for (const authenticated of options.authenticated) {
    const { projection } = authenticated;
    const stat = options.candidateFs.lstat(projection.destinationPath);
    if ((stat.mode & S_IFMT) !== S_IFREG) {
      throw new Error(
        `projected program must be a regular file: ${projection.destinationPath}`,
      );
    }
    if (stat.uid !== 0 || stat.gid !== 0) {
      throw new Error(
        `projected program must be root-owned: ${projection.destinationPath}`,
      );
    }
    if ((stat.mode & MODE_BITS) !== 0o4755) {
      throw new Error(
        `projected program has an unreviewed mode: ${projection.destinationPath}`,
      );
    }
    const destinationIdentity = captureMemoryFileSystemInodeIdentity(
      options.candidateFs,
      projection.destinationPath,
    );
    const destinationKey = identityKey(destinationIdentity);
    // WHY: JavaScript cannot compare the underlying shared data block of two
    // distinct SharedArrayBuffer wrappers. The one-shot private-construction
    // proof consumed by the private publisher is authoritative for
    // cross-wrapper non-aliasing. Validation-only callers receive no mount
    // authority; this exact tuple comparison remains required evidence and
    // rejects every identity the runtime can directly equate.
    if (writableIdentities.has(destinationKey)) {
      throw new Error(
        `projected program collides with a writable bottle inode: ${projection.destinationPath}`,
      );
    }
    if (stat.nlink !== 1) {
      throw new Error(
        `projected program must have one unique inode and no writable alias: ${projection.destinationPath}`,
      );
    }
    if (destinationIdentities.has(destinationKey)) {
      throw new Error(
        `projected programs must not preserve a hard link: ${projection.destinationPath}`,
      );
    }
    destinationIdentities.add(destinationKey);
    evidence.push({
      sourcePath: projection.sourcePath,
      canonicalSourcePath: authenticated.canonicalSourcePath,
      destinationPath: projection.destinationPath,
      sourceIdentity: authenticated.identity,
      destinationIdentity,
      collidesWithWritableBottle: false,
    });
  }

  assertExactProductNamespace(options.candidateFs);
  return evidence;
}

function consumePrivatelyStagedCandidate(candidateFs: MemoryFileSystem): void {
  if (!privatelyStagedCandidates.delete(candidateFs)) {
    throw new Error(
      "privileged product candidate was not privately staged by the publisher",
    );
  }
}

function initializeProductTree(fs: MemoryFileSystem): void {
  ensureDirRecursive(fs, "/usr/bin", 0o755);
  for (const path of ["/", "/usr", "/usr/bin"]) {
    fs.chown(path, 0, 0);
    fs.chmod(path, 0o755);
  }
}

async function validateImmutableProductBackend(
  backend: FileSystemBackend,
  authenticatedSources: readonly AuthenticatedProgramSource[],
): Promise<void> {
  assertSecureProductParents(backend);
  assertExactProductNamespace(backend);
  for (const { projection } of authenticatedSources) {
    const stat = backend.lstat(projection.destinationPath);
    if (
      (stat.mode & S_IFMT) !== S_IFREG || stat.uid !== 0 || stat.gid !== 0 ||
      (stat.mode & MODE_BITS) !== 0o4755 || stat.nlink !== 1
    ) {
      throw new Error(
        `immutable projected program metadata changed: ${projection.destinationPath}`,
      );
    }
    const actualDigest = await sha256Hex(
      readRegularFile(backend, projection.destinationPath),
    );
    if (actualDigest !== projection.artifactValidationSha256) {
      throw new Error(
        `projected artifact digest mismatch for ${projection.destinationPath}`,
      );
    }
  }
}

async function serializeImmutableProduct(
  backend: FileSystemBackend,
  authenticatedSources: readonly AuthenticatedProgramSource[],
): Promise<Uint8Array> {
  const productBytes = authenticatedSources.reduce(
    (sum, source) => sum + source.bytes.byteLength,
    0,
  );
  const artifactFs = MemoryFileSystem.create(new SharedArrayBuffer(Math.max(
    MIN_PRODUCT_CAPACITY,
    productBytes + 2 * 1024 * 1024,
  )));
  initializeProductTree(artifactFs);
  for (const { projection } of authenticatedSources) {
    writeVfsBinary(
      artifactFs,
      projection.destinationPath,
      readRegularFile(backend, projection.destinationPath),
      0o755,
    );
    artifactFs.chown(projection.destinationPath, 0, 0);
    artifactFs.chmod(projection.destinationPath, 0o4755);
  }
  return artifactFs.saveImage({ normalizeTimestampsMs: 0 });
}

async function serializeImmutableBrowserMount(
  backend: FileSystemBackend,
  authenticatedSources: readonly AuthenticatedProgramSource[],
): Promise<Uint8Array> {
  const productBytes = authenticatedSources.reduce(
    (sum, source) => sum + source.bytes.byteLength,
    0,
  );
  const artifactFs = MemoryFileSystem.create(new SharedArrayBuffer(Math.max(
    MIN_PRODUCT_CAPACITY,
    productBytes + 2 * 1024 * 1024,
  )));
  artifactFs.chown("/", 0, 0);
  artifactFs.chmod("/", 0o755);
  for (const { projection } of authenticatedSources) {
    const destination = projection.destinationPath.slice("/usr/bin".length);
    writeVfsBinary(
      artifactFs,
      destination,
      readRegularFile(backend, projection.destinationPath),
      0o755,
    );
    artifactFs.chown(destination, 0, 0);
    artifactFs.chmod(destination, 0o4755);
  }
  return artifactFs.saveImage({ normalizeTimestampsMs: 0 });
}

async function authenticateProgramSources(
  projections: readonly PrivilegedProgramProjection[],
  sources: readonly PrivilegedProgramSource[],
): Promise<AuthenticatedProgramSource[]> {
  const sourcesByFormula = new Map<string, PrivilegedProgramSource>();
  for (const source of sources) {
    const formula = requireNonemptyString(source.formula, "source formula");
    if (sourcesByFormula.has(formula)) {
      throw new Error(`duplicate privileged source formula ${formula}`);
    }
    sourcesByFormula.set(formula, source);
  }

  const authenticated: AuthenticatedProgramSource[] = [];
  for (const projection of projections) {
    const source = sourcesByFormula.get(projection.formula);
    if (source === undefined) {
      throw new Error(`privileged source is missing for ${projection.formula}`);
    }
    if (source.bottleSha256 !== projection.bottleSha256) {
      throw new Error(`bottle digest mismatch for ${projection.formula}`);
    }
    const inventory = validateSourceInventory(source.inventory.entries);
    const canonicalSourcePath = resolveCanonicalRegularSource(
      projection.sourcePath,
      inventory,
    );
    const guestPath = source.guestPathForSource(canonicalSourcePath);
    requireCanonicalGuestPath(guestPath, "privileged source guest path");
    const stat = source.fs.lstat(guestPath);
    if ((stat.mode & S_IFMT) !== S_IFREG) {
      throw new Error(
        `canonical privileged source is not regular: ${canonicalSourcePath}`,
      );
    }
    const canonicalEntry = inventory.get(canonicalSourcePath)!;
    if (stat.size !== canonicalEntry.size) {
      throw new Error(`privileged source size mismatch for ${projection.formula}`);
    }
    if (stat.size > MAX_PROGRAM_BYTES) {
      throw new Error(`privileged source exceeds byte limit for ${projection.formula}`);
    }
    const bytes = readRegularFile(source.fs, guestPath);
    const actualDigest = await sha256Hex(bytes);
    if (actualDigest !== projection.artifactValidationSha256) {
      throw new Error(`artifact digest mismatch for ${projection.formula}`);
    }
    authenticated.push({
      projection,
      source,
      canonicalSourcePath,
      guestPath,
      bytes,
      identity: captureMemoryFileSystemInodeIdentity(source.fs, guestPath),
    });
  }
  return authenticated;
}

function validateSourceInventory(
  entries: readonly PrivilegedProgramSourceInventoryEntry[],
): Map<string, PrivilegedProgramSourceInventoryEntry> {
  if (!Array.isArray(entries)) {
    throw new Error("privileged source requires a complete inventory");
  }
  const byPath = new Map<string, PrivilegedProgramSourceInventoryEntry>();
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`privileged source inventory entry ${index} is invalid`);
    }
    const sourcePath = requireCanonicalSourcePath(
      entry.sourcePath,
      `privileged source inventory entry ${index}`,
    );
    if (byPath.has(sourcePath)) {
      throw new Error(`privileged source inventory duplicates ${sourcePath}`);
    }
    if (!["directory", "file", "symlink", "hardlink"].includes(entry.type)) {
      throw new Error(`privileged source inventory type is invalid at ${sourcePath}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`privileged source inventory size is invalid at ${sourcePath}`);
    }
    if (entry.type === "file" || entry.type === "directory") {
      if (entry.target !== undefined) {
        throw new Error(`privileged source inventory target is invalid at ${sourcePath}`);
      }
    } else {
      requireCanonicalSourcePath(
        entry.target,
        `privileged source inventory target at ${sourcePath}`,
      );
    }
    byPath.set(sourcePath, entry);
  }
  return byPath;
}

function resolveCanonicalRegularSource(
  sourcePath: string,
  inventory: ReadonlyMap<string, PrivilegedProgramSourceInventoryEntry>,
): string {
  let current = sourcePath;
  const seen = new Set<string>();
  while (true) {
    const entry = inventory.get(current);
    if (entry === undefined) {
      throw new Error(
        `privileged source is absent from the complete inventory: ${current}`,
      );
    }
    if (entry.type === "symlink") {
      throw new Error(`privileged source must not be a symlink: ${current}`);
    }
    if (entry.type === "file") return current;
    if (entry.type !== "hardlink") {
      throw new Error(`privileged source must resolve to a regular file: ${current}`);
    }
    if (seen.has(current)) {
      throw new Error(`privileged source hard-link cycle at ${current}`);
    }
    seen.add(current);
    current = entry.target!;
  }
}

function assertSecureProductParents(fs: FileSystemBackend): void {
  for (const path of ["/", "/usr", "/usr/bin"]) {
    const stat = fs.lstat(path);
    if ((stat.mode & S_IFMT) !== S_IFDIR || stat.uid !== 0 || stat.gid !== 0) {
      throw new Error(`privileged product parent must be a root-owned directory: ${path}`);
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new Error(`privileged product parent must not be writable: ${path}`);
    }
  }
}

function assertExactProductNamespace(fs: FileSystemBackend): void {
  const expected = new Set<string>([
    "/",
    "/usr",
    "/usr/bin",
    ...PRODUCT_DESTINATIONS,
  ]);
  for (const path of walkFileSystem(fs)) {
    if (!expected.delete(path)) {
      throw new Error(`privileged product has a writable alias or extra path: ${path}`);
    }
  }
  if (expected.size !== 0) {
    throw new Error(
      `privileged product is incomplete: ${Array.from(expected).join(", ")}`,
    );
  }
}

function collectTreeIdentityKeys(
  fileSystems: readonly MemoryFileSystem[],
): Set<string> {
  const identities = new Set<string>();
  for (const fs of fileSystems) {
    for (const path of walkFileSystem(fs)) {
      identities.add(identityKey(captureMemoryFileSystemInodeIdentity(fs, path)));
    }
  }
  return identities;
}

function walkFileSystem(fs: FileSystemBackend): string[] {
  const paths: string[] = [];
  const pending = ["/"];
  while (pending.length !== 0) {
    const path = pending.pop()!;
    paths.push(path);
    if ((fs.lstat(path).mode & S_IFMT) !== S_IFDIR) continue;
    const handle = fs.opendir(path);
    try {
      while (true) {
        const entry = fs.readdir(handle);
        if (entry === null) break;
        if (entry.name === "." || entry.name === "..") continue;
        const child = path === "/" ? `/${entry.name}` : `${path}/${entry.name}`;
        pending.push(child);
      }
    } finally {
      fs.closedir(handle);
    }
  }
  return paths;
}

function readRegularFile(fs: FileSystemBackend, path: string): Uint8Array {
  const stat = fs.lstat(path);
  if ((stat.mode & S_IFMT) !== S_IFREG || !Number.isSafeInteger(stat.size)) {
    throw new Error(`cannot authenticate non-regular file ${path}`);
  }
  const bytes = new Uint8Array(stat.size);
  const handle = fs.open(path, OPEN_FLAGS.O_RDONLY, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.read(
        handle,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (!Number.isInteger(read) || read <= 0) {
        throw new Error(`unexpected EOF while authenticating ${path}`);
      }
      offset += read;
    }
  } finally {
    fs.close(handle);
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error("Web Crypto SHA-256 is unavailable");
  }
  const copy = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function identityKey(identity: MemoryFileSystemInodeIdentity): string {
  return `${identity.dev}:${identity.ino}:${identity.generation}`;
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain record`);
  }
  return value as Record<string, unknown>;
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function requireSha256(value: unknown, label: string): string {
  const digest = requireNonemptyString(value, label);
  if (!SHA256_RE.test(digest)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return digest;
}

function requireCanonicalSourcePath(value: unknown, label: string): string {
  const path = requireNonemptyString(value, label);
  const segments = path.split("/");
  if (
    path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be a canonical relative path`);
  }
  return path;
}

function requireCanonicalGuestPath(value: unknown, label: string): string {
  const path = requireNonemptyString(value, label);
  if (!path.startsWith("/")) {
    throw new Error(`${label} must be absolute`);
  }
  const segments = path.slice(1).split("/");
  if (
    path.includes("\\") || path.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be canonical`);
  }
  return path;
}
