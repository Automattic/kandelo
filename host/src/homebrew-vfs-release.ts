/**
 * Resolve one immutable, browser-proven Homebrew VFS release.
 *
 * This module is intentionally browser-compatible. Node and browser callers
 * must parse the same descriptor and verify the same image byte count and
 * SHA-256 digest before passing bytes to a VFS implementation.
 */

export const HOMEBREW_VFS_DESCRIPTOR_ASSET = "kandelo-homebrew-vfs.json";
export const HOMEBREW_VFS_IMAGE_ASSET = "kandelo-homebrew.vfs.zst";
export const MAX_HOMEBREW_VFS_DESCRIPTOR_BYTES = 256 * 1024;
export const MAX_HOMEBREW_VFS_IMAGE_BYTES = 256 * 1024 * 1024;

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_REQUESTED_PACKAGES = 128;
const MAX_DEPENDENCY_EDGES = 512;
const MAX_ARGV = 64;
const MAX_STRING_BYTES = 4096;
const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAP_NAME_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const FORMULA_RE = /^[a-z0-9][a-z0-9._-]*$/;
const GUEST_PATH_RE = /^\/(?:[A-Za-z0-9._@%+=:-]+\/)*[A-Za-z0-9._@%+=:-]+$/;

export interface HomebrewVfsAsset {
  asset: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface HomebrewVfsImageAsset extends HomebrewVfsAsset {
  kernel_abi: number;
}

export interface HomebrewVfsDefaultShell {
  path: string;
  argv: string[];
}

export interface HomebrewVfsReleaseDescriptor {
  schema: 1;
  kind: "kandelo-homebrew-vfs";
  formula: string;
  arch: "wasm32";
  tap: {
    repository: string;
    name: string;
    commit: string;
  };
  kandelo: {
    repository: string;
    commit: string;
    abi: number;
  };
  bottle_release_tag: string;
  selection: {
    requested_packages: string[];
    dependency_edges: Array<{ from: string; to: string; version: string }>;
  };
  acceptance: {
    node: "success";
    browser: "chromium";
    executable: string;
    argv: string[];
  };
  release: {
    repository: string;
    tag: string;
  };
  image: HomebrewVfsImageAsset;
  evidence: {
    report: HomebrewVfsAsset;
    node: HomebrewVfsAsset;
    browser: HomebrewVfsAsset;
  };
  launch: {
    query_parameter: "vfs";
    value: string;
  };
  default_shell?: HomebrewVfsDefaultShell;
}

export interface HomebrewVfsFetchOptions {
  fetch?: typeof fetch;
  maxImageBytes?: number;
}

export interface ResolvedHomebrewVfsRelease {
  descriptorUrl: string;
  descriptor: HomebrewVfsReleaseDescriptor;
  imageBytes: Uint8Array;
}

export class HomebrewVfsReleaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HomebrewVfsReleaseError";
  }
}

/**
 * Fetch and validate the small release descriptor, without downloading its
 * image. The descriptor URL itself must be the conventional GitHub release
 * asset URL named by the descriptor.
 */
export async function fetchHomebrewVfsReleaseDescriptor(
  descriptorUrl: string,
  expectedAbi: number,
  options: HomebrewVfsFetchOptions = {},
): Promise<HomebrewVfsReleaseDescriptor> {
  const normalizedUrl = normalizeDescriptorUrl(descriptorUrl);
  const bytes = await fetchBoundedBytes(
    normalizedUrl,
    "Homebrew VFS release descriptor",
    MAX_HOMEBREW_VFS_DESCRIPTOR_BYTES,
    options.fetch,
  );
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    fail(
      `Homebrew VFS release descriptor is not valid UTF-8 JSON: ${errorMessage(error)}`,
    );
  }
  return parseHomebrewVfsReleaseDescriptor(value, normalizedUrl, expectedAbi, {
    maxImageBytes: options.maxImageBytes,
  });
}

/** Validate an already-decoded schema-1 release descriptor. */
export function parseHomebrewVfsReleaseDescriptor(
  value: unknown,
  descriptorUrl: string,
  expectedAbi: number,
  options: Pick<HomebrewVfsFetchOptions, "maxImageBytes"> = {},
): HomebrewVfsReleaseDescriptor {
  if (!Number.isInteger(expectedAbi) || expectedAbi < 1) {
    fail("expected Kandelo ABI must be a positive integer");
  }
  const normalizedDescriptorUrl = normalizeDescriptorUrl(descriptorUrl);
  const maxImageBytes = normalizeMaximum(
    options.maxImageBytes ?? MAX_HOMEBREW_VFS_IMAGE_BYTES,
    "Homebrew VFS image byte cap",
  );
  const root = record(value, "Homebrew VFS release descriptor");
  exactKeys(root, [
    "schema",
    "kind",
    "formula",
    "arch",
    "tap",
    "kandelo",
    "bottle_release_tag",
    "selection",
    "acceptance",
    "release",
    "image",
    "evidence",
    "launch",
    ...(Object.hasOwn(root, "default_shell") ? ["default_shell"] : []),
  ], "Homebrew VFS release descriptor");
  exact(root.schema, 1, "Homebrew VFS descriptor schema");
  exact(root.kind, "kandelo-homebrew-vfs", "Homebrew VFS descriptor kind");
  exact(root.arch, "wasm32", "Homebrew VFS descriptor architecture");
  const formula = formulaName(root.formula, "Homebrew VFS Formula");

  const tap = record(root.tap, "Homebrew VFS tap");
  exactKeys(tap, ["repository", "name", "commit"], "Homebrew VFS tap");
  const tapRepository = repository(tap.repository, "Homebrew VFS tap repository");
  const tapName = canonicalTapName(tap.name, "Homebrew VFS tap name");
  validateTapIdentity(tapRepository, tapName);
  const tapCommit = commit(tap.commit, "Homebrew VFS tap commit");

  const kandelo = record(root.kandelo, "Homebrew VFS Kandelo source");
  exactKeys(kandelo, ["repository", "commit", "abi"], "Homebrew VFS Kandelo source");
  const kandeloRepository = repository(
    kandelo.repository,
    "Homebrew VFS Kandelo repository",
  );
  const kandeloCommit = commit(kandelo.commit, "Homebrew VFS Kandelo commit");
  const abi = integer(kandelo.abi, "Homebrew VFS Kandelo ABI", 1);
  exact(abi, expectedAbi, "Homebrew VFS Kandelo ABI");
  const bottleReleaseTag = stringValue(
    root.bottle_release_tag,
    "Homebrew VFS bottle release tag",
    255,
  );
  exact(
    bottleReleaseTag,
    `bottles-abi-v${expectedAbi}`,
    "Homebrew VFS bottle release tag",
  );

  const release = record(root.release, "Homebrew VFS release");
  exactKeys(release, ["repository", "tag"], "Homebrew VFS release");
  const releaseRepository = repository(
    release.repository,
    "Homebrew VFS release repository",
  );
  exact(releaseRepository, tapRepository, "Homebrew VFS release repository");
  const releaseTag = stringValue(release.tag, "Homebrew VFS release tag", 255);

  const image = parseAsset(
    root.image,
    "Homebrew VFS image",
    releaseRepository,
    releaseTag,
    HOMEBREW_VFS_IMAGE_ASSET,
    maxImageBytes,
    true,
  ) as HomebrewVfsImageAsset;
  exact(image.kernel_abi, expectedAbi, "Homebrew VFS image kernel ABI");
  exact(
    releaseTag,
    `homebrew-vfs-sha256-${image.sha256}`,
    "Homebrew VFS content-addressed release tag",
  );
  exact(
    normalizedDescriptorUrl,
    releaseAssetUrl(releaseRepository, releaseTag, HOMEBREW_VFS_DESCRIPTOR_ASSET),
    "Homebrew VFS descriptor URL",
  );

  const selection = record(root.selection, "Homebrew VFS selection");
  exactKeys(
    selection,
    ["requested_packages", "dependency_edges"],
    "Homebrew VFS selection",
  );
  const requestedRaw = array(selection.requested_packages, "Homebrew VFS requested packages");
  if (requestedRaw.length < 1 || requestedRaw.length > MAX_REQUESTED_PACKAGES) {
    fail(
      `Homebrew VFS requested packages must contain 1 to ${MAX_REQUESTED_PACKAGES} entries`,
    );
  }
  const requestedPackages = requestedRaw.map((entry, index) =>
    formulaName(entry, `Homebrew VFS requested package ${index}`));
  if (!requestedPackages.includes(formula)) {
    fail("Homebrew VFS selected Formula is not one of the requested package roots");
  }
  if (new Set(requestedPackages).size !== requestedPackages.length) {
    fail("Homebrew VFS requested packages contain a duplicate");
  }
  const edgesRaw = array(selection.dependency_edges, "Homebrew VFS dependency edges");
  if (edgesRaw.length < 1 || edgesRaw.length > MAX_DEPENDENCY_EDGES) {
    fail(`Homebrew VFS dependency edges must contain 1 to ${MAX_DEPENDENCY_EDGES} entries`);
  }
  const dependencyEdges = edgesRaw.map((entry, index) => {
    const edge = record(entry, `Homebrew VFS dependency edge ${index}`);
    exactKeys(edge, ["from", "to", "version"], `Homebrew VFS dependency edge ${index}`);
    return {
      from: packageFullName(edge.from, `Homebrew VFS dependency edge ${index} source`),
      to: packageFullName(edge.to, `Homebrew VFS dependency edge ${index} target`),
      version: stringValue(edge.version, `Homebrew VFS dependency edge ${index} version`, 255),
    };
  });
  const selectedFullName = `${tapName}/${formula}`;
  if (!dependencyEdges.some((edge) => edge.from === selectedFullName)) {
    fail("Homebrew VFS selected Formula has no recorded dependency edge");
  }

  const acceptance = record(root.acceptance, "Homebrew VFS acceptance");
  exactKeys(
    acceptance,
    ["node", "browser", "executable", "argv"],
    "Homebrew VFS acceptance",
  );
  exact(acceptance.node, "success", "Homebrew VFS Node acceptance");
  exact(acceptance.browser, "chromium", "Homebrew VFS browser acceptance");
  const executable = guestPath(
    acceptance.executable,
    "Homebrew VFS accepted executable",
  );
  const acceptanceArgv = argv(acceptance.argv, "Homebrew VFS acceptance argv");

  const evidence = record(root.evidence, "Homebrew VFS evidence");
  exactKeys(evidence, ["report", "node", "browser"], "Homebrew VFS evidence");
  const report = parseAsset(
    evidence.report,
    "Homebrew VFS report evidence",
    releaseRepository,
    releaseTag,
    "kandelo-homebrew-vfs-report.json",
    MAX_EVIDENCE_BYTES,
    false,
  );
  const node = parseAsset(
    evidence.node,
    "Homebrew VFS Node evidence",
    releaseRepository,
    releaseTag,
    "kandelo-homebrew-node-evidence.json",
    MAX_EVIDENCE_BYTES,
    false,
  );
  const browser = parseAsset(
    evidence.browser,
    "Homebrew VFS browser evidence",
    releaseRepository,
    releaseTag,
    "kandelo-homebrew-browser-evidence.json",
    MAX_EVIDENCE_BYTES,
    false,
  );

  const launch = record(root.launch, "Homebrew VFS launch");
  exactKeys(launch, ["query_parameter", "value"], "Homebrew VFS launch");
  exact(launch.query_parameter, "vfs", "Homebrew VFS launch query parameter");
  exact(launch.value, image.url, "Homebrew VFS launch image URL");

  let defaultShell: HomebrewVfsDefaultShell | undefined;
  if (Object.hasOwn(root, "default_shell")) {
    const shell = record(root.default_shell, "Homebrew VFS default shell");
    exactKeys(shell, ["path", "argv"], "Homebrew VFS default shell");
    defaultShell = {
      path: guestPath(shell.path, "Homebrew VFS default shell path"),
      argv: argv(shell.argv, "Homebrew VFS default shell argv"),
    };
  }

  return {
    schema: 1,
    kind: "kandelo-homebrew-vfs",
    formula,
    arch: "wasm32",
    tap: { repository: tapRepository, name: tapName, commit: tapCommit },
    kandelo: { repository: kandeloRepository, commit: kandeloCommit, abi },
    bottle_release_tag: bottleReleaseTag,
    selection: {
      requested_packages: requestedPackages,
      dependency_edges: dependencyEdges,
    },
    acceptance: {
      node: "success",
      browser: "chromium",
      executable,
      argv: acceptanceArgv,
    },
    release: { repository: releaseRepository, tag: releaseTag },
    image,
    evidence: { report, node, browser },
    launch: { query_parameter: "vfs", value: image.url },
    ...(defaultShell ? { default_shell: defaultShell } : {}),
  };
}

/** Fetch exact image bytes and fail unless both size and SHA-256 match. */
export async function fetchVerifiedHomebrewVfsImage(
  image: Pick<HomebrewVfsImageAsset, "url" | "sha256" | "bytes">,
  options: HomebrewVfsFetchOptions = {},
): Promise<Uint8Array> {
  const maxImageBytes = normalizeMaximum(
    options.maxImageBytes ?? MAX_HOMEBREW_VFS_IMAGE_BYTES,
    "Homebrew VFS image byte cap",
  );
  const expectedBytes = integer(image.bytes, "Homebrew VFS image byte count", 1);
  if (expectedBytes > maxImageBytes) {
    fail(`Homebrew VFS image exceeds the ${maxImageBytes}-byte consumer cap`);
  }
  const expectedSha = sha256(image.sha256, "Homebrew VFS image SHA-256");
  const imageUrl = httpsUrl(image.url, "Homebrew VFS image URL");
  const bytes = await fetchBoundedBytes(
    imageUrl,
    "Homebrew VFS image",
    maxImageBytes,
    options.fetch,
    expectedBytes,
  );
  const actualSha = await sha256Hex(bytes);
  if (actualSha !== expectedSha) {
    fail(`Homebrew VFS image SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`);
  }
  return bytes;
}

/** Fetch the descriptor and its exact verified image through one shared path. */
export async function resolveHomebrewVfsRelease(
  descriptorUrl: string,
  expectedAbi: number,
  options: HomebrewVfsFetchOptions = {},
): Promise<ResolvedHomebrewVfsRelease> {
  const normalizedUrl = normalizeDescriptorUrl(descriptorUrl);
  const descriptor = await fetchHomebrewVfsReleaseDescriptor(
    normalizedUrl,
    expectedAbi,
    options,
  );
  const imageBytes = await fetchVerifiedHomebrewVfsImage(descriptor.image, options);
  return { descriptorUrl: normalizedUrl, descriptor, imageBytes };
}

function parseAsset(
  value: unknown,
  label: string,
  repositoryName: string,
  tag: string,
  expectedAsset: string,
  maximumBytes: number,
  image: boolean,
): HomebrewVfsAsset | HomebrewVfsImageAsset {
  const asset = record(value, label);
  exactKeys(
    asset,
    image ? ["asset", "url", "sha256", "bytes", "kernel_abi"] : ["asset", "url", "sha256", "bytes"],
    label,
  );
  exact(asset.asset, expectedAsset, `${label} asset name`);
  const url = httpsUrl(asset.url, `${label} URL`);
  exact(url, releaseAssetUrl(repositoryName, tag, expectedAsset), `${label} URL`);
  const digest = sha256(asset.sha256, `${label} SHA-256`);
  const bytes = integer(asset.bytes, `${label} byte count`, 1);
  if (bytes > maximumBytes) fail(`${label} exceeds the ${maximumBytes}-byte cap`);
  const base = { asset: expectedAsset, url, sha256: digest, bytes };
  if (!image) return base;
  return {
    ...base,
    kernel_abi: integer(asset.kernel_abi, `${label} kernel ABI`, 1),
  };
}

async function fetchBoundedBytes(
  url: string,
  label: string,
  maximumBytes: number,
  fetchOverride?: typeof fetch,
  expectedBytes?: number,
): Promise<Uint8Array> {
  const fetchImpl = fetchOverride ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") fail(`${label} cannot be fetched in this runtime`);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
    });
  } catch (error) {
    fail(`${label} fetch failed: ${errorMessage(error)}`);
  }
  if (!response.ok) fail(`${label} fetch failed with HTTP ${response.status}`);
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== undefined && contentLength > maximumBytes) {
    fail(`${label} Content-Length exceeds the ${maximumBytes}-byte cap`);
  }
  const contentEncoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  if (
    expectedBytes !== undefined &&
    contentLength !== undefined &&
    (!contentEncoding || contentEncoding === "identity") &&
    contentLength !== expectedBytes
  ) {
    fail(`${label} Content-Length mismatch: expected ${expectedBytes}, got ${contentLength}`);
  }
  if (!response.body) fail(`${label} response has no readable body`);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes || (expectedBytes !== undefined && total > expectedBytes)) {
        await reader.cancel().catch(() => {});
        fail(`${label} exceeded its declared byte count or consumer cap while downloading`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (expectedBytes !== undefined && total !== expectedBytes) {
    fail(`${label} byte count mismatch: expected ${expectedBytes}, got ${total}`);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail("SHA-256 verification is unavailable in this runtime");
  const digest = await subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeDescriptorUrl(value: string): string {
  const url = httpsUrl(value, "Homebrew VFS descriptor URL");
  if (url !== value) {
    fail("Homebrew VFS descriptor URL must already be an absolute canonical HTTPS URL");
  }
  if (!/^https:\/\/github\.com\//.test(url)) {
    fail("Homebrew VFS descriptor URL must be a public github.com release asset URL");
  }
  return url;
}

function releaseAssetUrl(repositoryName: string, tag: string, asset: string): string {
  return `https://github.com/${repositoryName}/releases/download/${tag}/${asset}`;
}

function validateTapIdentity(repositoryName: string, tapName: string): void {
  const [owner, repositoryLeaf] = repositoryName.toLowerCase().split("/", 2);
  if (!repositoryLeaf.startsWith("homebrew-") || repositoryLeaf.length === "homebrew-".length) {
    fail("Homebrew VFS tap repository must use the conventional owner/homebrew-name form");
  }
  const expected = `${owner}/${repositoryLeaf.slice("homebrew-".length)}`;
  exact(tapName, expected, "Homebrew VFS canonical tap name");
}

function guestPath(value: unknown, label: string): string {
  const result = stringValue(value, label, MAX_STRING_BYTES);
  if (!GUEST_PATH_RE.test(result)) {
    fail(`${label} must be an absolute guest file path`);
  }
  const parts = result.split("/").slice(1);
  if (parts.some((part) => !part || part === "." || part === "..")) {
    fail(`${label} must be normalized`);
  }
  return result;
}

function argv(value: unknown, label: string): string[] {
  const raw = array(value, label);
  if (raw.length < 1 || raw.length > MAX_ARGV) {
    fail(`${label} must contain 1 to ${MAX_ARGV} entries`);
  }
  let total = 0;
  return raw.map((entry, index) => {
    const result = stringValue(entry, `${label} entry ${index}`, MAX_STRING_BYTES);
    total += new TextEncoder().encode(result).byteLength;
    if (total > 64 * 1024) fail(`${label} exceeds 65536 bytes`);
    return result;
  });
}

function packageFullName(value: unknown, label: string): string {
  const result = stringValue(value, label, 3 * 255);
  const parts = result.split("/");
  if (
    parts.length !== 3 ||
    !/^[a-z0-9_.-]+$/.test(parts[0]) ||
    !/^[a-z0-9_.-]+$/.test(parts[1]) ||
    !FORMULA_RE.test(parts[2])
  ) {
    fail(`${label} must be a canonical lowercase owner/tap/formula name`);
  }
  return result;
}

function repository(value: unknown, label: string): string {
  const result = stringValue(value, label, 255);
  if (!REPOSITORY_RE.test(result)) fail(`${label} must be owner/repository`);
  return result;
}

function canonicalTapName(value: unknown, label: string): string {
  const result = stringValue(value, label, 255);
  if (!TAP_NAME_RE.test(result)) fail(`${label} must be a canonical lowercase owner/tap name`);
  return result;
}

function formulaName(value: unknown, label: string): string {
  const result = stringValue(value, label, 255);
  if (!FORMULA_RE.test(result)) fail(`${label} is not a valid Formula name`);
  return result;
}

function commit(value: unknown, label: string): string {
  const result = stringValue(value, label, 40);
  if (!COMMIT_RE.test(result)) fail(`${label} must be an exact lowercase commit SHA`);
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = stringValue(value, label, 64);
  if (!SHA256_RE.test(result)) fail(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function httpsUrl(value: unknown, label: string): string {
  const result = stringValue(value, label, MAX_STRING_BYTES);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    fail(`${label} must be an absolute HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    fail(`${label} must be an absolute HTTPS URL without credentials, query, or fragment`);
  }
  if (parsed.href !== result) {
    fail(`${label} must already be a canonical HTTPS URL`);
  }
  return parsed.href;
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : undefined;
}

function normalizeMaximum(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2 * 1024 * 1024 * 1024) {
    fail(`${label} must be an integer from 1 through 2147483648`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} has unexpected or missing fields`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function stringValue(value: unknown, label: string, maximum = MAX_STRING_BYTES): string {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    fail(`${label} must be a non-empty string without NUL`);
  }
  if (new TextEncoder().encode(value).byteLength > maximum) {
    fail(`${label} exceeds ${maximum} bytes`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${label} must be an integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function exact(value: unknown, expected: unknown, label: string): void {
  if (value !== expected) fail(`${label} is ${JSON.stringify(value)}, expected ${JSON.stringify(expected)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): never {
  throw new HomebrewVfsReleaseError(message);
}
