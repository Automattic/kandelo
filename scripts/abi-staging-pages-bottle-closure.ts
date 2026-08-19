import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/u;
const FORMULA = /^[a-z0-9][a-z0-9@+._-]{0,127}$/u;
const MAX_FORMULA_BYTES = 4 * 1024 * 1024;
const MAX_TAGS = 16_384;
const MAX_FORMULAS = 512;

export interface CanonicalPagesBottleTransport {
  fetchBlob(repository: string, digest: string, bytes: number): Promise<Uint8Array>;
  listTags(repository: string): Promise<string[]>;
  fetchManifest(reference: string): Promise<Uint8Array>;
}

export interface CanonicalPagesBottleV1 {
  schema: 1;
  abi: number;
  formula: string;
  bottle_sha256: string;
  bottle_bytes: number;
  canonical_reference: string;
  descriptor_sha256: string;
  descriptor_bytes: number;
}

export async function resolveCanonicalPagesBottleClosure(options: {
  abi: number;
  formulas: readonly string[];
  tapRoot: string;
  transport: CanonicalPagesBottleTransport;
}): Promise<CanonicalPagesBottleV1[]> {
  if (
    !Array.isArray(options.formulas) || options.formulas.length < 1 ||
    options.formulas.length > MAX_FORMULAS ||
    options.formulas.some((formula) => typeof formula !== "string" || !FORMULA.test(formula))
  ) throw new Error("Pages Formula closure is invalid");
  const formulas = [...options.formulas].sort();
  if (new Set(formulas).size !== formulas.length) {
    throw new Error("Pages Formula closure is not unique");
  }
  const outcomes = await Promise.allSettled(formulas.map((formula) =>
    resolveCanonicalPagesBottle({
      abi: options.abi,
      formula,
      tapRoot: options.tapRoot,
      transport: options.transport,
    })
  ));
  const failures = outcomes.flatMap((outcome, index) =>
    outcome.status === "rejected"
      ? [`${formulas[index]}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`]
      : []
  );
  if (failures.length > 0) {
    throw new Error(`canonical Pages bottle closure is incomplete:\n${failures.join("\n")}`);
  }
  return outcomes.map((outcome) => {
    if (outcome.status !== "fulfilled") throw new Error("unreachable Pages closure outcome");
    return outcome.value;
  });
}

export async function resolveCanonicalPagesBottle(options: {
  abi: number;
  formula: string;
  tapRoot: string;
  transport: CanonicalPagesBottleTransport;
}): Promise<CanonicalPagesBottleV1> {
  if (!Number.isSafeInteger(options.abi) || options.abi < 1) {
    throw new Error("Pages target ABI is invalid");
  }
  if (!FORMULA.test(options.formula)) throw new Error("Pages Formula name is invalid");
  const tapRoot = realDirectory(options.tapRoot, "Pages tap root");
  const formulaPath = within(tapRoot, `Formula/${options.formula}.rb`);
  const sidecarPath = within(tapRoot, `Kandelo/formula/${options.formula}.json`);
  const formulaSource = readRegularText(formulaPath, `${options.formula} Formula`);
  const sidecar = parseSidecar(
    JSON.parse(readRegularText(sidecarPath, `${options.formula} sidecar`)),
    options.formula,
    options.abi,
  );
  const repository =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${options.abi}/${options.formula}`;
  const formulaBottle = parseFormulaBottle(formulaSource, options.formula);
  if (formulaBottle.repository !== repository) {
    throw new Error(`${options.formula} Formula bottle repository differs from its ABI`);
  }
  if (formulaBottle.sha256 !== sidecar.sha256) {
    throw new Error(`${options.formula} Formula bottle digest differs from its sidecar`);
  }
  if (
    sidecar.url !==
      `https://ghcr.io/v2/${repository.slice("ghcr.io/".length)}/blobs/sha256:${sidecar.sha256}`
  ) {
    throw new Error(`${options.formula} sidecar bottle URL differs from its identity`);
  }

  const tags = await options.transport.listTags(repository);
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    throw new Error(`${options.formula} canonical tag inventory exceeds its bound`);
  }
  const digests = [...new Set(tags.flatMap((tag) => {
    const match = typeof tag === "string"
      ? tag.match(/^canonical-sha256-([0-9a-f]{64})$/u)
      : null;
    return match === null ? [] : [match[1]!];
  }))].sort();
  const matches: Array<CanonicalPagesBottleV1> = [];
  for (const digest of digests) {
    const reference = `${repository}@sha256:${digest}`;
    const bytes = await options.transport.fetchManifest(reference);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_FORMULA_BYTES || sha256(bytes) !== digest) {
      throw new Error(`${options.formula} canonical manifest differs from its immutable tag`);
    }
    const identity = canonicalManifestIdentity(
      bytes,
      options.formula,
      options.abi,
      sidecar.sha256,
      sidecar.bytes,
    );
    if (identity !== null) {
      const config = await options.transport.fetchBlob(
        repository,
        `sha256:${identity.configSha256}`,
        identity.configBytes,
      );
      if (
        config.byteLength !== identity.configBytes ||
        sha256(config) !== identity.configSha256
      ) throw new Error(`${options.formula} canonical config differs from its descriptor`);
      validateCanonicalConfig(
        config,
        options.formula,
        options.abi,
        sidecar.sha256,
        sidecar.bytes,
        identity.metadataSha256,
        identity.metadataBytes,
        identity.descriptorSha256,
        identity.descriptorBytes,
      );
      matches.push({
        schema: 1,
        abi: options.abi,
        formula: options.formula,
        bottle_sha256: sidecar.sha256,
        bottle_bytes: sidecar.bytes,
        canonical_reference: reference,
        descriptor_sha256: identity.descriptorSha256,
        descriptor_bytes: identity.descriptorBytes,
      });
    }
  }
  if (matches.length === 0) {
    throw new Error(`${options.formula} lacks one canonical ABI ${options.abi} manifest`);
  }
  if (matches.length !== 1) {
    throw new Error(`${options.formula} has multiple canonical manifests for its current bottle`);
  }
  return matches[0]!;
}

function parseFormulaBottle(source: string, formula: string): {
  repository: string;
  sha256: string;
} {
  const blocks = [...source.matchAll(/^  bottle do\n([\s\S]*?)^  end$/gmu)];
  if (blocks.length !== 1) throw new Error(`${formula} Formula lacks one bottle stanza`);
  const body = blocks[0]![1]!;
  const roots = [...body.matchAll(/^    root_url "([^"]+)"$/gmu)];
  const digests = [...body.matchAll(
    /^    sha256 cellar: "\/opt\/kandelo\/homebrew\/Cellar", wasm32_kandelo: "([0-9a-f]{64})"$/gmu,
  )];
  if (roots.length !== 1 || digests.length !== 1) {
    throw new Error(`${formula} Formula bottle stanza is not exact`);
  }
  const prefix = "https://ghcr.io/v2/";
  if (!roots[0]![1]!.startsWith(prefix)) {
    throw new Error(`${formula} Formula bottle root is not GHCR`);
  }
  return {
    repository: `ghcr.io/${roots[0]![1]!.slice(prefix.length)}`,
    sha256: digests[0]![1]!,
  };
}

function parseSidecar(value: unknown, formula: string, abi: number): {
  bytes: number;
  sha256: string;
  url: string;
} {
  const sidecar = record(value, `${formula} sidecar`);
  if (
    sidecar.schema !== 1 || sidecar.name !== formula ||
    sidecar.full_name !== `kandelo-dev/tap-core/${formula}` ||
    sidecar.kandelo_abi !== abi || sidecar.formula_path !== `Formula/${formula}.rb`
  ) throw new Error(`${formula} sidecar identity differs from the current Formula`);
  if (!Array.isArray(sidecar.bottles)) throw new Error(`${formula} sidecar bottles are invalid`);
  const matches = sidecar.bottles.map((value) => record(value, `${formula} bottle`))
    .filter((bottle) => bottle.arch === "wasm32");
  if (matches.length !== 1) throw new Error(`${formula} sidecar lacks one wasm32 bottle`);
  const bottle = matches[0]!;
  if (
    bottle.bottle_tag !== "wasm32_kandelo" || bottle.kandelo_abi !== abi ||
    bottle.status !== "success" || bottle.cellar !== "/opt/kandelo/homebrew/Cellar" ||
    bottle.prefix !== "/opt/kandelo/homebrew" || !SHA256.test(String(bottle.sha256)) ||
    bottle.cache_key_sha !== bottle.sha256 || !Number.isSafeInteger(bottle.bytes) ||
    bottle.bytes < 1 || typeof bottle.url !== "string"
  ) throw new Error(`${formula} sidecar bottle identity is invalid`);
  return { bytes: bottle.bytes, sha256: bottle.sha256, url: bottle.url };
}

function canonicalManifestIdentity(
  bytes: Uint8Array,
  formula: string,
  abi: number,
  bottleSha256: string,
  bottleBytes: number,
): {
  configBytes: number;
  configSha256: string;
  descriptorSha256: string;
  descriptorBytes: number;
  metadataBytes: number;
  metadataSha256: string;
} | null {
  const manifest = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    "canonical bottle manifest");
  const annotations = record(manifest.annotations, "canonical bottle manifest annotations");
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    manifest.artifactType !== "application/vnd.kandelo.homebrew.canonical-bottle.v1+json" ||
    annotations["dev.kandelo.abi-staging.formula"] !== formula ||
    annotations["dev.kandelo.abi-staging.target-abi"] !== String(abi) ||
    !Array.isArray(manifest.layers)
  ) throw new Error("canonical manifest Formula identity differs from its selection");
  const layers = manifest.layers.map((value) => record(value, "canonical bottle layer"));
  const roleOf = (layer: Record<string, unknown>) =>
    record(layer.annotations, "canonical bottle layer annotations")
      ["dev.kandelo.abi-staging.role"];
  const byRole = (role: string) => layers.filter((layer) => roleOf(layer) === role);
  const bottles = byRole("bottle-layer");
  const metadataLayers = byRole("bottle-metadata");
  const descriptors = byRole("vfs-composition-descriptor");
  if (
    layers.length !== 3 || bottles.length !== 1 || metadataLayers.length !== 1 ||
    descriptors.length !== 1
  ) {
    throw new Error("canonical bottle manifest layer roles are incomplete");
  }
  if (![
    "bottle-layer",
    "bottle-metadata",
    "vfs-composition-descriptor",
  ].every((role, index) => roleOf(layers[index]!) === role)) {
    throw new Error("canonical bottle manifest layer order differs from readback");
  }
  const bottle = layerIdentity(bottles[0]!);
  if (bottle.sha256 !== bottleSha256 || bottle.bytes !== bottleBytes) return null;
  const config = configIdentity(record(manifest.config, "canonical bottle config descriptor"));
  const metadata = layerIdentity(metadataLayers[0]!);
  const descriptor = layerIdentity(descriptors[0]!);
  return {
    configBytes: config.bytes,
    configSha256: config.sha256,
    descriptorSha256: descriptor.sha256,
    descriptorBytes: descriptor.bytes,
    metadataBytes: metadata.bytes,
    metadataSha256: metadata.sha256,
  };
}

function configIdentity(value: Record<string, unknown>): { bytes: number; sha256: string } {
  const annotations = record(value.annotations, "canonical bottle config annotations");
  if (
    value.mediaType !== "application/vnd.kandelo.homebrew.canonical-bottle.v1+json" ||
    annotations["dev.kandelo.abi-staging.role"] !== "canonical-bottle-metadata" ||
    annotations["org.opencontainers.image.title"] !== "canonical-bottle.json"
  ) throw new Error("canonical bottle config descriptor has unsupported identity");
  const identity = layerIdentity(value);
  if (identity.bytes > MAX_FORMULA_BYTES) {
    throw new Error("canonical bottle config exceeds its byte bound");
  }
  return identity;
}

function validateCanonicalConfig(
  bytes: Uint8Array,
  formula: string,
  abi: number,
  bottleSha256: string,
  bottleBytes: number,
  metadataSha256: string,
  metadataBytes: number,
  descriptorSha256: string,
  descriptorBytes: number,
): void {
  const value = record(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    "canonical bottle config",
  );
  const selectedFormula = record(value.formula, "canonical bottle config Formula");
  const bottle = record(value.bottle_layer, "canonical bottle config layer");
  const metadata = record(value.bottle_metadata, "canonical bottle config metadata");
  const descriptor = record(
    value.vfs_composition_descriptor,
    "canonical bottle config descriptor",
  );
  if (
    value.schema !== 1 || value.kind !== "kandelo-homebrew-canonical-bottle" ||
    !["canonical-direct", "canonical-pending-admission"].includes(String(value.classification)) ||
    selectedFormula.tap !== "kandelo-dev/homebrew-tap-core" ||
    selectedFormula.name !== formula || selectedFormula.architecture !== "wasm32" ||
    selectedFormula.target_abi !== abi ||
    bottle.sha256 !== bottleSha256 || bottle.bytes !== bottleBytes ||
    metadata.sha256 !== metadataSha256 || metadata.bytes !== metadataBytes ||
    descriptor.sha256 !== descriptorSha256 || descriptor.bytes !== descriptorBytes
  ) throw new Error(`${formula} canonical config Formula identity differs from its selection`);
}

function layerIdentity(value: Record<string, unknown>): { bytes: number; sha256: string } {
  const digest = typeof value.digest === "string"
    ? value.digest.match(/^sha256:([0-9a-f]{64})$/u)?.[1]
    : undefined;
  if (digest === undefined || !Number.isSafeInteger(value.size) || Number(value.size) < 1) {
    throw new Error("canonical bottle layer identity is invalid");
  }
  return { bytes: Number(value.size), sha256: digest };
}

function readRegularText(path: string, label: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_FORMULA_BYTES) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return readFileSync(path, "utf8");
}

function realDirectory(path: string, label: string): string {
  const resolved = resolve(path);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} is not a real directory`);
  return resolved;
}

function within(root: string, relativePath: string): string {
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Pages tap path escapes its root");
  return path;
}

function record(value: unknown, label: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, any>;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
