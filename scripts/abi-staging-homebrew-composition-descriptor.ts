import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  buildHomebrewOriginalBottleCollection,
} from "../host/src/homebrew-lazy-layer";
import type {
  HomebrewLinkManifest,
  HomebrewVfsPackagePlan,
  HomebrewVfsPlan,
} from "../host/src/homebrew-vfs-planner";
import {
  parseHomebrewOriginalBottleTreeDescriptor,
  type HomebrewOriginalBottleTreeDescriptorV1,
} from "../host/src/homebrew-runtime-layer-consumer";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";

const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9+._-]{0,127}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const ARCHITECTURES = new Set(["wasm32", "wasm64"]);
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MIN_MEMORY_BYTES = 8 * 1024 * 1024;
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;

export interface HomebrewCompositionInputV1 {
  schema: 1;
  kind: "kandelo-abi-staging-homebrew-composition-input";
  source: { repository: string; commit: string; tree: string };
  tap_source: { repository: string; commit: string; tree: string };
  formula: {
    name: string;
    full_name: string;
    version: string;
    pkg_version: string;
    revision: number;
    rebuild: number;
    architecture: "wasm32" | "wasm64";
    target_abi: number;
    normalized_formula_sha256: string;
  };
  bottle: {
    sha256: string;
    bytes: number;
    immutable_reference: string;
    transport_url: string;
  };
  required_by: string[];
  link_manifest: HomebrewLinkManifest;
}

export interface BuildCompositionOptionsV1 {
  memoryBytes?: number;
}

export interface ReissueCompositionOptionsV1 {
  bottleSha256: string;
  bottleBytes: number;
  candidateUrl: string;
  canonicalUrl: string;
}

/**
 * Derive filesystem composition truth from the exact bottle bytes once, while
 * keeping the resulting bottle payload lazy in every VFS product that selects
 * it. Formula metadata is deliberately not accepted by this interface.
 */
export async function buildHomebrewCompositionDescriptor(
  value: unknown,
  bottleBytes: Uint8Array,
  options: BuildCompositionOptionsV1 = {},
): Promise<HomebrewOriginalBottleTreeDescriptorV1> {
  const input = validateCompositionInput(value);
  if (
    !(bottleBytes instanceof Uint8Array) ||
    bottleBytes.byteLength !== input.bottle.bytes ||
    digest(bottleBytes) !== input.bottle.sha256
  ) {
    throw new Error("Homebrew composition bottle bytes differ from their exact identity");
  }
  const memoryBytes = options.memoryBytes ?? DEFAULT_MEMORY_BYTES;
  if (
    !Number.isSafeInteger(memoryBytes) || memoryBytes < MIN_MEMORY_BYTES ||
    memoryBytes > MAX_MEMORY_BYTES || memoryBytes % 65_536 !== 0
  ) {
    throw new Error("Homebrew composition memory bound is invalid");
  }

  const formula = input.formula;
  const link = input.link_manifest;
  const pkg: HomebrewVfsPackagePlan = {
    name: formula.name,
    fullName: formula.full_name,
    tapRepository: input.tap_source.repository,
    tapName: tapName(input.tap_source.repository),
    tapCommit: input.tap_source.commit,
    kandeloRepository: input.source.repository,
    kandeloCommit: input.source.commit,
    version: formula.pkg_version,
    formulaRevision: formula.revision,
    bottleRebuild: formula.rebuild,
    arch: formula.architecture,
    kandeloAbi: formula.target_abi,
    metadataStatus: "success",
    sourceStatus: "success",
    url: input.bottle.transport_url,
    sha256: input.bottle.sha256,
    bytes: input.bottle.bytes,
    cacheKeySha: input.bottle.sha256,
    prefix: link.prefix,
    cellar: link.cellar,
    keg: link.keg,
    payloadRoot: link.bottle.payload_root,
    linkManifestPath:
      `Kandelo/staging/composition/${formula.name}-${formula.version}-` +
      `rebuild${formula.rebuild}-${formula.architecture}.json`,
    linkManifest: structuredClone(link),
    dependencies: [],
    runtimeSupport: ["node", "browser"],
    browserCompatible: true,
    builtFrom: {
      tapRepository: input.tap_source.repository,
      tapCommit: input.tap_source.commit,
      kandeloRepository: input.source.repository,
      kandeloCommit: input.source.commit,
      formulaSha256: formula.normalized_formula_sha256,
    },
  };
  const plan: HomebrewVfsPlan = {
    schema: 1,
    tapRepository: input.tap_source.repository,
    tapName: tapName(input.tap_source.repository),
    tapCommit: input.tap_source.commit,
    kandeloRepository: input.source.repository,
    kandeloCommit: input.source.commit,
    kandeloAbi: formula.target_abi,
    releaseTag: `abi-${formula.target_abi}-composition`,
    requestedPackages: [formula.name],
    packages: [pkg],
  };
  const collection = await buildHomebrewOriginalBottleCollection(plan, {
    fs: MemoryFileSystem.create(new SharedArrayBuffer(memoryBytes)),
    baseFs: MemoryFileSystem.create(new SharedArrayBuffer(MIN_MEMORY_BYTES)),
    loadBottleBytes: () => bottleBytes,
    treeIdOverrides: new Map([[formula.full_name, formula.name]]),
  });
  const payload = collection.payloads[0];
  if (
    collection.deferredTrees.length !== 1 || collection.payloads.length !== 1 ||
    payload === undefined || payload.id !== formula.name ||
    payload.bytes.byteLength !== bottleBytes.byteLength ||
    digest(payload.bytes) !== input.bottle.sha256
  ) {
    throw new Error("Homebrew composition producer did not preserve one exact bottle tree");
  }
  const tree = structuredClone(collection.deferredTrees[0]!);
  tree.transports = [{ kind: "external-https", url: input.bottle.transport_url }];
  return parseHomebrewOriginalBottleTreeDescriptor(
    {
      schema: 1,
      kind: "kandelo-homebrew-original-bottle-tree",
      architecture: formula.architecture,
      tap: input.tap_source.repository,
      formula: formula.name,
      required_by: [...input.required_by],
      tree,
    },
    {
      architecture: formula.architecture,
      tap: input.tap_source.repository,
      formula: formula.name,
      package: formula.full_name,
      bottle: { sha256: input.bottle.sha256, bytes: input.bottle.bytes },
      allowedRoots: new Set(input.required_by),
    },
  );
}

/**
 * Reissue only location authority after bottle admission. Inventory and bottle
 * identity remain byte-for-byte equal; no bottle layer is rebuilt.
 */
export function reissueHomebrewCompositionDescriptor(
  value: unknown,
  options: ReissueCompositionOptionsV1,
): HomebrewOriginalBottleTreeDescriptorV1 {
  if (!SHA256.test(options.bottleSha256) || !positive(options.bottleBytes)) {
    throw new Error("Homebrew composition reissue bottle identity is invalid");
  }
  const candidateTransport = requireBottleTransport(
    options.candidateUrl,
    options.bottleSha256,
    "candidate",
  );
  const canonicalTransport = requireBottleTransport(
    options.canonicalUrl,
    options.bottleSha256,
    "canonical",
  );
  const candidate = exactRecord(value, [
    "architecture",
    "formula",
    "kind",
    "required_by",
    "schema",
    "tap",
    "tree",
  ], "Homebrew composition descriptor") as unknown as HomebrewOriginalBottleTreeDescriptorV1;
  if (
    candidateTransport.owner !== canonicalTransport.owner ||
    candidateTransport.repository !== canonicalTransport.repository ||
    candidateTransport.abi !== canonicalTransport.abi ||
    candidateTransport.formula !== canonicalTransport.formula ||
    candidate.tap !== `${candidateTransport.owner}/${candidateTransport.repository}` ||
    candidate.formula !== candidateTransport.formula
  ) {
    throw new Error("Homebrew composition reissue changes managed bottle identity");
  }
  const roots = [...candidate.required_by];
  const packageName = `${tapName(candidate.tap)}/${candidate.formula}`;
  const parsed = parseHomebrewOriginalBottleTreeDescriptor(candidate, {
    architecture: candidate.architecture,
    tap: candidate.tap,
    formula: candidate.formula,
    package: packageName,
    bottle: { sha256: options.bottleSha256, bytes: options.bottleBytes },
    allowedRoots: new Set(roots),
  });
  if (
    parsed.tree.transports.length !== 1 ||
    parsed.tree.transports[0]?.kind !== "external-https" ||
    parsed.tree.transports[0].url !== options.candidateUrl
  ) {
    throw new Error("Homebrew composition descriptor has another candidate transport");
  }
  const canonical = structuredClone(parsed);
  canonical.tree.transports = [{ kind: "external-https", url: options.canonicalUrl }];
  if (JSON.stringify(canonical).includes("-candidates/")) {
    throw new Error("canonical Homebrew composition descriptor retains candidate authority");
  }
  return parseHomebrewOriginalBottleTreeDescriptor(canonical, {
    architecture: canonical.architecture,
    tap: canonical.tap,
    formula: canonical.formula,
    package: packageName,
    bottle: { sha256: options.bottleSha256, bytes: options.bottleBytes },
    allowedRoots: new Set(roots),
  });
}

export function canonicalCompositionDescriptorBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(sortJson(value))}\n`);
}

function validateCompositionInput(value: unknown): HomebrewCompositionInputV1 {
  const root = exactRecord(value, [
    "bottle",
    "formula",
    "kind",
    "link_manifest",
    "required_by",
    "schema",
    "source",
    "tap_source",
  ], "Homebrew composition input");
  if (
    root.schema !== 1 ||
    root.kind !== "kandelo-abi-staging-homebrew-composition-input"
  ) {
    throw new Error("Homebrew composition input protocol is unsupported");
  }
  const source = validateSource(root.source, "Homebrew composition source");
  const tapSource = validateSource(root.tap_source, "Homebrew composition tap source");
  const formula = exactRecord(root.formula, [
    "architecture",
    "full_name",
    "name",
    "normalized_formula_sha256",
    "pkg_version",
    "rebuild",
    "revision",
    "target_abi",
    "version",
  ], "Homebrew composition Formula");
  const name = stableId(formula.name, "Homebrew composition Formula name");
  const architecture = formula.architecture;
  const expectedFullName = `${tapName(tapSource.repository)}/${name}`;
  const version = packageVersion(formula.version, "Homebrew composition Formula version");
  const revision = formula.revision;
  const expectedPkgVersion = revision === 0 ? version : `${version}_${revision}`;
  if (
    typeof architecture !== "string" || !ARCHITECTURES.has(architecture) ||
    formula.full_name !== expectedFullName ||
    !nonnegative(revision) || formula.pkg_version !== expectedPkgVersion ||
    !nonnegative(formula.rebuild) || !positive(formula.target_abi) ||
    !SHA256.test(String(formula.normalized_formula_sha256))
  ) {
    throw new Error("Homebrew composition Formula identity is invalid");
  }
  const bottle = exactRecord(root.bottle, [
    "bytes",
    "immutable_reference",
    "sha256",
    "transport_url",
  ], "Homebrew composition bottle");
  const bottleSha256 = String(bottle.sha256);
  const bottleBytes = bottle.bytes;
  if (!SHA256.test(bottleSha256) || !positive(bottleBytes)) {
    throw new Error("Homebrew composition bottle identity is invalid");
  }
  const candidateRepository = managedBottleRepository(
    tapSource.repository,
    formula.target_abi as number,
    name,
    "candidate",
  );
  if (
    bottle.immutable_reference !== `${candidateRepository}@sha256:${bottleSha256}` ||
    bottle.transport_url !==
      `https://ghcr.io/v2/${candidateRepository.slice("ghcr.io/".length)}/blobs/sha256:${bottleSha256}`
  ) {
    throw new Error("Homebrew composition bottle leaves its exact candidate namespace");
  }
  if (!Array.isArray(root.required_by)) {
    throw new Error("Homebrew composition required roots are not an array");
  }
  const requiredBy = root.required_by.map((item, index) =>
    stableId(item, `Homebrew composition required root ${index}`)
  );
  if (
    requiredBy.length === 0 || requiredBy.length > 256 ||
    JSON.stringify(requiredBy) !== JSON.stringify([...new Set(requiredBy)].sort())
  ) {
    throw new Error("Homebrew composition required roots are not canonical");
  }
  const link = structuredClone(root.link_manifest) as HomebrewLinkManifest;
  if (
    link?.schema !== 1 || link.package !== name || link.version !== expectedPkgVersion ||
    link.arch !== architecture || link.kandelo_abi !== formula.target_abi ||
    link.bottle?.url !== bottle.transport_url ||
    link.bottle?.sha256 !== bottleSha256 || link.bottle?.bytes !== bottleBytes ||
    link.bottle?.cache_key_sha !== bottleSha256
  ) {
    throw new Error("Homebrew composition link manifest differs from its bottle");
  }
  return {
    schema: 1,
    kind: "kandelo-abi-staging-homebrew-composition-input",
    source,
    tap_source: tapSource,
    formula: {
      name,
      full_name: expectedFullName,
      version,
      pkg_version: expectedPkgVersion,
      revision: revision as number,
      rebuild: formula.rebuild as number,
      architecture: architecture as "wasm32" | "wasm64",
      target_abi: formula.target_abi as number,
      normalized_formula_sha256: formula.normalized_formula_sha256 as string,
    },
    bottle: {
      sha256: bottleSha256,
      bytes: bottleBytes as number,
      immutable_reference: bottle.immutable_reference as string,
      transport_url: bottle.transport_url as string,
    },
    required_by: requiredBy,
    link_manifest: link,
  };
}

function validateSource(value: unknown, label: string): HomebrewCompositionInputV1["source"] {
  const source = exactRecord(value, ["commit", "repository", "tree"], label);
  if (
    typeof source.repository !== "string" || !REPOSITORY.test(source.repository) ||
    !GIT_SHA.test(String(source.commit)) || !GIT_SHA.test(String(source.tree))
  ) {
    throw new Error(`${label} identity is invalid`);
  }
  return {
    repository: source.repository,
    commit: source.commit as string,
    tree: source.tree as string,
  };
}

function tapName(repository: string): string {
  const [owner, name] = repository.split("/", 2);
  if (!owner || !name?.startsWith("homebrew-") || name.length === "homebrew-".length) {
    throw new Error("Homebrew composition tap repository cannot derive its tap name");
  }
  return `${owner}/${name.slice("homebrew-".length)}`;
}

function managedBottleRepository(
  tapRepository: string,
  abi: number,
  formula: string,
  referenceClass: "candidate" | "canonical",
): string {
  const [owner, repository] = tapRepository.split("/", 2);
  if (!owner || !repository?.startsWith("homebrew-") || !positive(abi)) {
    throw new Error("Homebrew composition managed repository identity is invalid");
  }
  const suffix = referenceClass === "candidate" ? "-candidates" : "";
  return `ghcr.io/${owner}/${repository}-abi-${abi}${suffix}/${formula}`;
}

function requireBottleTransport(
  value: string,
  sha256: string,
  referenceClass: "candidate" | "canonical",
): { owner: string; repository: string; abi: number; formula: string } {
  const suffix = referenceClass === "candidate" ? "-candidates" : "";
  const pattern = new RegExp(
    `^https://ghcr\\.io/v2/([A-Za-z0-9_.-]+)/` +
      `([A-Za-z0-9_.-]+)-abi-([1-9][0-9]*)${suffix}/` +
      `([a-z0-9][a-z0-9+._-]{0,127})/blobs/sha256:${sha256}$`,
    "u",
  );
  const match = pattern.exec(value);
  if (match === null || (referenceClass === "canonical" && value.includes("-candidates/"))) {
    throw new Error(`Homebrew composition ${referenceClass} transport is invalid`);
  }
  return {
    owner: match[1]!,
    repository: match[2]!,
    abi: Number(match[3]),
    formula: match[4]!,
  };
}

function exactRecord(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} fields changed`);
  }
  return record;
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function packageVersion(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, sortJson(item)]),
    );
  }
  return value;
}

async function main(argv: string[]): Promise<void> {
  let inputPath = "";
  let bottlePath = "";
  let outputPath = "";
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${String(flag)} requires a value`);
    if (flag === "--input") inputPath = value;
    else if (flag === "--bottle") bottlePath = value;
    else if (flag === "--out") outputPath = value;
    else throw new Error(`unknown flag ${String(flag)}`);
  }
  if (!inputPath || !bottlePath || !outputPath) {
    throw new Error("usage: --input INPUT --bottle BOTTLE --out OUTPUT");
  }
  const inputBytes = new Uint8Array(readFileSync(inputPath));
  if (inputBytes.byteLength === 0 || inputBytes.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("Homebrew composition input bytes are outside their bound");
  }
  const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputBytes));
  if (!Buffer.from(inputBytes).equals(Buffer.from(canonicalCompositionDescriptorBytes(input)))) {
    throw new Error("Homebrew composition input is not canonical JSON");
  }
  const descriptor = await buildHomebrewCompositionDescriptor(
    input,
    new Uint8Array(readFileSync(bottlePath)),
  );
  writeFileSync(outputPath, canonicalCompositionDescriptorBytes(descriptor), {
    flag: "wx",
    mode: 0o600,
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `abi-staging-homebrew-composition-descriptor: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
