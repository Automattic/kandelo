#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  collectProductInputObjectsFromResolvedSources,
  verifyExactProductSourceIdentity,
  type ResolvedProductInputCollectionOptions,
} from "./abi-staging-collect-product-inputs.ts";
import {
  canonicalPagesInputReference,
  canonicalPagesInputSitePath,
  computePagesReadiness,
  finalizePagesReadiness,
  preparePagesProducts,
  type AdmissionEnvelopeV1,
  type CanonicalProductBuildRequestV1,
  type CanonicalOciReadbackV1,
  type PagesEvidenceRequestV1,
  type PreparedPagesProductsV1,
  type PagesReadinessInputV1,
} from "./abi-staging-pages-readiness.ts";
import {
  exactRuntimeDevShellLockSha256,
  runtimeIdentityFromBundle,
  superviseNodeEvidenceCli,
  validateExactRuntimeArtifactRoot,
  type CandidateProductLocatorV1,
  type CliOptions as NodeEvidenceCliOptions,
  type NodeEvidenceContextV1,
} from "./abi-staging-product-node-evidence.ts";
import {
  superviseBrowserEvidenceCli,
  type BrowserEvidenceCliOptions,
  type BrowserEvidenceContextV1,
} from "./abi-staging-product-browser-evidence.ts";
import { runVfsProductBuilderCli } from "./run-vfs-product-builder.ts";
import { readPagesRegistry } from "./check-pages-vfs-product-registry.mjs";
import {
  buildFinalPagesSite,
  type BuildFinalPagesSiteOptions,
  type PagesSiteMetadataV1,
} from "./abi-staging-pages-site-builder.ts";

type JsonObject = Record<string, any>;

const CANDIDATE_ARTIFACT_TYPE =
  "application/vnd.kandelo.abi-staging.product.candidate.v1+json";
const OCI_MANIFEST_MEDIA_TYPE = "application/vnd.oci.image.manifest.v1+json";
const VFS_IMAGE_MEDIA_TYPE = "application/vnd.kandelo.vfs.image.v1";
const BUILDER_REPORT_MEDIA_TYPE = "application/vnd.kandelo.vfs.builder-report.v1+json";
const RESOLVED_INPUTS_MEDIA_TYPE = "application/vnd.kandelo.vfs.resolved-inputs.v1+json";
const RUNTIME_BUNDLE_MEDIA_TYPE =
  "application/vnd.kandelo.abi-staging.runtime-bundle.v1+json";
const LAZY_INPUT_MEDIA_TYPE = "application/vnd.kandelo.vfs.lazy-input.v1";
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_RUNTIME_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_VFS_BYTES = 256 * 1024 * 1024;
const MAX_LAZY_INPUTS = 4_096;
const MAX_LAZY_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_LAZY_INPUT_AGGREGATE_BYTES = 8 * 1024 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_OCI_TAGS = 16_384;
const MAX_SITE_BYTES = 1_000_000_000;
const MAX_SITE_FILES = 65_536;
const PROTECTED_REPOSITORY = "Automattic/kandelo";
const PROTECTED_TAP_REPOSITORY = "kandelo-dev/homebrew-tap-core";
const PROTECTED_WORKFLOWS = new Set([
  "Automattic/kandelo/.github/workflows/abi-staging-pages-canary.yml@refs/heads/main",
  "Automattic/kandelo/.github/workflows/browser-demos-pages.yml@refs/heads/main",
]);

export interface CandidateProductReadback {
  fetchManifest(reference: string): Promise<Uint8Array>;
  fetchBlob(repository: string, digest: string, bytes: number): Promise<Uint8Array>;
}

export interface CandidateProductDiscovery extends CandidateProductReadback {
  listImmutableReferences(repository: string): Promise<string[]>;
}

export interface CandidateProductAuthorityV1 {
  builderReport: JsonObject;
  candidateRecord: JsonObject;
  lazyInputs: Map<string, { bytes: number; sha256: string }>;
  resolvedInputs: JsonObject;
  runtimeBundle: JsonObject;
  runtimeBundleBytes: Uint8Array;
}

interface LocalLazyBody {
  body: Uint8Array;
  bytes: number;
  sha256: string;
}

export function createLocalLazyFetcher(
  bodies: ReadonlyMap<string, LocalLazyBody>,
): (
  sources: readonly { url: string; sourceUrl: string; sha256: string; size: number }[],
) => (url: string, init?: { signal?: AbortSignal }) => Promise<Response> {
  return (sources) => {
    const selected = new Map<string, LocalLazyBody>();
    for (const source of sources) {
      if (selected.has(source.url)) {
        throw new Error("closed local lazy transport contains a duplicate URL");
      }
      const exact = bodies.get(source.url);
      if (
        exact === undefined || exact.bytes !== source.size ||
        exact.sha256 !== source.sha256 || exact.body.byteLength !== source.size ||
        sha256(exact.body) !== source.sha256
      ) throw new Error(`closed local lazy transport ${source.url} differs from its exact body`);
      selected.set(source.url, exact);
    }
    return async (url, init) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      const exact = selected.get(url);
      if (exact === undefined) {
        throw new Error(`closed local lazy transport does not bind URL ${url}`);
      }
      const responseBody = exact.body.slice();
      return new Response(responseBody.buffer as ArrayBuffer, {
        status: 200,
        headers: { "content-length": String(responseBody.byteLength) },
      });
    };
  };
}

interface ExactSourceObservation {
  commit: string;
  devShellLockSha256: string;
  root: string;
  tree: string;
}

interface ExactTapObservation {
  commit: string;
  repository: string;
  root: string;
  tree: string;
}

export function createExactSourceReobserver(
  expected: ExactSourceObservation,
  verify: (value: ExactSourceObservation) => void = verifyExactProductSourceIdentity,
): () => void {
  verify(expected);
  return () => verify(expected);
}

export function createExactTapReobserver(
  expected: ExactTapObservation,
  verify: (value: ExactTapObservation) => void = verifyExactTapSourceIdentity,
): () => void {
  verify(expected);
  return () => verify(expected);
}

function verifyExactTapSourceIdentity(expected: ExactTapObservation): void {
  const root = exactDirectory(expected.root, "exact current tap-main root");
  const topLevel = exactDirectory(
    gitTapOutput(root, ["rev-parse", "--show-toplevel"]),
    "exact current tap-main Git root",
  );
  if (topLevel !== root) throw new Error("exact tap root is not the Git checkout root");
  const remote = gitTapOutput(root, ["remote", "get-url", "origin"]);
  if (remote !== `https://github.com/${expected.repository}.git`) {
    throw new Error("exact tap repository differs from the protected public tap");
  }
  const commit = gitTapOutput(root, ["rev-parse", "--verify", "HEAD"]);
  const tree = gitTapOutput(root, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (commit !== expected.commit || tree !== expected.tree) {
    throw new Error("exact tap Git identity differs from the protected handoff");
  }
  const status = gitTapOutput(
    root,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    true,
  );
  if (status !== "") throw new Error("exact tap checkout is not clean");
}

function gitTapOutput(root: string, args: string[], permitEmpty = false): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: MAX_DOCUMENT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(`cannot observe exact tap Git identity: ${String(result.stderr).trim()}`);
  }
  const value = String(result.stdout).trim();
  if (!permitEmpty && value === "") throw new Error("exact tap Git identity is empty");
  return value;
}

export function heldPagesReadinessRecord(options: {
  blockers: Array<{ detail: string; kind: string; product_id: string }>;
  pagesRegistry: {
    path: string;
    products: Array<{ id: string; load: "eager" | "lazy" }>;
    sha256: string;
  };
  source: { repository: string; commit: string; tree: string };
  tapSource: { repository: string; commit: string; tree: string };
  targetAbi: { version: number; snapshot_sha256: string };
}): JsonObject {
  if (options.blockers.length === 0) {
    throw new Error("hold-only Pages readiness requires at least one blocker");
  }
  return {
    blockers: options.blockers.map((value) => ({
      detail: value.detail.slice(0, 4_096),
      guard_code: "pages_product_incomplete",
      kind: value.kind,
      product_id: value.product_id,
    })),
    kind: "kandelo-pages-readiness",
    pages_registry: options.pagesRegistry,
    products: [],
    ready: false,
    schema: 1,
    site_metadata_sha256: null,
    source: options.source,
    tap_source: options.tapSource,
    target_abi: options.targetAbi,
  };
}

export class PagesProductUnavailableError extends Error {
  constructor(
    readonly blockerKind: "candidate-input-missing" | "missing-admission",
    message: string,
  ) {
    super(message);
  }
}

export function isExpectedCurrentInputUnavailable(error: unknown): boolean {
  if (
    typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === "ENOENT"
  ) return true;
  return error instanceof Error && / lacks current bytes for [a-z0-9._-]+$/u.test(error.message);
}

export function writeAtomicHoldOnlyOutput(
  staging: string,
  output: string,
  readiness: unknown,
): void {
  const hold = mkdtempSync(join(dirname(output), ".pages-hold-"));
  try {
    writeCanonical(join(hold, "readiness.json"), readiness);
    if (!jsonEqual(readdirSync(hold).sort(ordinal), ["readiness.json"])) {
      throw new Error("hold-only Pages output contains non-readiness artifacts");
    }
    rmSync(staging, { force: true, recursive: true });
    renameSync(hold, output);
  } catch (error) {
    rmSync(hold, { force: true, recursive: true });
    throw error;
  }
}

export interface PagesProductionHandoffV1 {
  schema: 1;
  kind: "kandelo-pages-production-handoff";
  source_root: string;
  source: { repository: string; commit: string; tree: string };
  tap_root: string;
  tap_source: { repository: string; commit: string; tree: string };
  target_abi: { version: number; snapshot_sha256: string };
  runtime_bundle: string;
  runtime_root: string;
  site_source_root: string;
  run: {
    repository: string;
    workflow_ref: string;
    run_id: number;
    attempt: number;
  };
  products: Array<{
    id: string;
    current_inputs: {
      archive_files: string;
      package_roots: string;
      program_index: string;
    };
  }>;
}

export function validatePagesProductionHandoff(
  value: unknown,
): PagesProductionHandoffV1 {
  const input = record(value, "Pages production handoff");
  exactKeys(input, [
    "kind", "products", "run", "runtime_bundle", "runtime_root", "schema",
    "site_source_root", "source", "source_root", "tap_root", "tap_source", "target_abi",
  ], "Pages production handoff");
  if (input.schema !== 1 || input.kind !== "kandelo-pages-production-handoff") {
    throw new Error("Pages production handoff has unsupported identity");
  }
  const source = record(input.source, "Pages production source");
  exactKeys(source, ["commit", "repository", "tree"], "Pages production source");
  if (
    source.repository !== PROTECTED_REPOSITORY ||
    !/^[0-9a-f]{40}$/u.test(source.commit) || !/^[0-9a-f]{40}$/u.test(source.tree)
  ) throw new Error("Pages production source identity is invalid");
  const tapSource = record(input.tap_source, "Pages production tap source");
  exactKeys(tapSource, ["commit", "repository", "tree"], "Pages production tap source");
  if (
    tapSource.repository !== PROTECTED_TAP_REPOSITORY ||
    !/^[0-9a-f]{40}$/u.test(tapSource.commit) || !/^[0-9a-f]{40}$/u.test(tapSource.tree)
  ) throw new Error("Pages production tap source identity is invalid");
  const target = record(input.target_abi, "Pages production target ABI");
  exactKeys(target, ["snapshot_sha256", "version"], "Pages production target ABI");
  if (
    !Number.isSafeInteger(target.version) || target.version < 1 ||
    !SHA256.test(target.snapshot_sha256)
  ) throw new Error("Pages production target ABI is invalid");
  const run = record(input.run, "Pages production run");
  exactKeys(run, ["attempt", "repository", "run_id", "workflow_ref"], "Pages production run");
  if (
    run.repository !== source.repository || typeof run.workflow_ref !== "string" ||
    !PROTECTED_WORKFLOWS.has(run.workflow_ref) ||
    !Number.isSafeInteger(run.run_id) || run.run_id < 1 ||
    !Number.isSafeInteger(run.attempt) || run.attempt < 1
  ) throw new Error("Pages production run is not a protected main run");
  const paths = [
    input.runtime_bundle, input.runtime_root, input.site_source_root, input.source_root,
    input.tap_root,
  ];
  const products = array(input.products, "Pages production products");
  if (products.length === 0 || products.length > 4_096) {
    throw new Error("Pages production product set is outside its bound");
  }
  let previous = "";
  const checkedProducts = products.map((value, index) => {
    const product = record(value, `Pages production product ${index}`);
    exactKeys(product, ["current_inputs", "id"], `Pages production product ${index}`);
    const id = stableId(product.id, `Pages production product ${index} ID`);
    if (id <= previous) throw new Error("Pages production products are not sorted and unique");
    previous = id;
    const current = record(product.current_inputs, `${id} current input authorities`);
    exactKeys(current, ["archive_files", "package_roots", "program_index"],
      `${id} current input authorities`);
    paths.push(current.archive_files, current.package_roots, current.program_index);
    return {
      id,
      current_inputs: {
        archive_files: absolutePath(current.archive_files, `${id} archive map`),
        package_roots: absolutePath(current.package_roots, `${id} package roots`),
        program_index: absolutePath(current.program_index, `${id} program index`),
      },
    };
  });
  paths.forEach((path, index) => absolutePath(path, `Pages production path ${index}`));
  return {
    schema: 1,
    kind: "kandelo-pages-production-handoff",
    source_root: input.source_root,
    source: source as PagesProductionHandoffV1["source"],
    tap_root: input.tap_root,
    tap_source: tapSource as PagesProductionHandoffV1["tap_source"],
    target_abi: target as PagesProductionHandoffV1["target_abi"],
    runtime_bundle: input.runtime_bundle,
    runtime_root: input.runtime_root,
    site_source_root: input.site_source_root,
    run: run as PagesProductionHandoffV1["run"],
    products: checkedProducts,
  };
}

export async function discoverCandidateProductAuthority(
  expected: {
    productId: string;
    source: { repository: string; commit: string; tree: string };
    targetAbi: { version: number; snapshot_sha256: string };
  },
  discovery: CandidateProductDiscovery,
): Promise<{ reference: string; authority: CandidateProductAuthorityV1 }> {
  const repository =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${expected.targetAbi.version}` +
    `-candidates/products/${stableId(expected.productId, "candidate product ID")}`;
  const listed = await discovery.listImmutableReferences(repository);
  if (!Array.isArray(listed) || listed.length > MAX_OCI_TAGS) {
    throw new Error("candidate product immutable locator set exceeds its bound");
  }
  const references = [...new Set(listed)].sort(ordinal);
  if (references.length !== listed.length) {
    throw new Error("candidate product immutable locator set contains duplicates");
  }
  const matches: Array<{ reference: string; authority: CandidateProductAuthorityV1 }> = [];
  for (const reference of references) {
    validateCandidateProductReference(
      reference,
      expected.productId,
      expected.targetAbi.version,
    );
    const authority = await readCandidateProductAuthority(reference, {
      ...expected,
      permitOtherSourceTree: true,
    }, discovery);
    if (
      authority.candidateRecord.source.repository === expected.source.repository &&
      authority.candidateRecord.source.tree === expected.source.tree
    ) matches.push({ authority, reference });
  }
  if (matches.length === 0) {
    throw new PagesProductUnavailableError(
      "candidate-input-missing",
      `candidate product ${expected.productId} lacks an immutable current-tree record`,
    );
  }
  if (matches.length !== 1) {
    const identity = candidateProductSelectionIdentity(matches[0]!.authority);
    if (matches.some(({ authority }) =>
      !jsonEqual(candidateProductSelectionIdentity(authority), identity))) {
      throw new Error(
        `candidate product ${expected.productId} has conflicting immutable current-tree records`,
      );
    }
  }
  matches.sort((left, right) => ordinal(left.reference, right.reference));
  return matches[0]!;
}

function candidateProductSelectionIdentity(
  authority: CandidateProductAuthorityV1,
): JsonObject {
  const recordValue = structuredClone(authority.candidateRecord);
  const resolved = structuredClone(authority.resolvedInputs);
  const report = structuredClone(authority.builderReport);
  const runtime = structuredClone(authority.runtimeBundle);
  delete recordValue.source.commit;
  delete resolved.source.commit;
  delete report.resolved_inputs_sha256;
  if (runtime.source !== undefined) delete runtime.source.commit;
  const hasCommitSensitiveRepositoryInput = resolved.inputs.some(
    (input: JsonObject) => input.kind === "repository-path",
  );
  resolved.inputs = resolved.inputs.map((input: JsonObject) => {
    if (input.kind !== "repository-path") return input;
    const normalized = structuredClone(input);
    delete normalized.bytes;
    delete normalized.path;
    delete normalized.reference;
    delete normalized.sha256;
    return normalized;
  });
  report.inputs = report.inputs.map((input: JsonObject) => {
    if (input.kind !== "repository-path") return input;
    const normalized = structuredClone(input);
    delete normalized.bytes;
    delete normalized.sha256;
    return normalized;
  });
  if (hasCommitSensitiveRepositoryInput) {
    delete report.output.bytes;
    delete report.output.sha256;
  }
  const lazyInputs = recordValue.artifacts.lazy_inputs.map((input: JsonObject) => {
    if (input.kind !== "repository-path") return input;
    return { id: input.id, kind: input.kind };
  });
  return {
    builder_report: report,
    lazy_inputs: lazyInputs,
    product: recordValue.product,
    resolved_inputs: resolved,
    runtime_bundle: runtime,
    source: recordValue.source,
    target_abi: recordValue.target_abi,
    ...(hasCommitSensitiveRepositoryInput
      ? {}
      : { vfs_image: recordValue.artifacts.vfs_image }),
  };
}

interface PagesFileIdentityV1 {
  bytes: number;
  path: string;
  sha256: string;
}

export function derivePagesSiteMetadata(
  siteSourceRoot: string,
  pagesRegistry: unknown,
  galleryAuthority: unknown,
  presetSource: string,
  liveSetupSource: string,
): JsonObject {
  const root = exactDirectory(siteSourceRoot, "Pages site source root");
  const pages = record(pagesRegistry, "Pages registry");
  exactKeys(pages, ["kind", "products", "schema"], "Pages registry");
  if (pages.schema !== 1 || pages.kind !== "kandelo-pages-vfs-products") {
    throw new Error("Pages registry has unsupported identity");
  }
  const gallery = record(galleryAuthority, "Pages gallery authority");
  exactKeys(gallery, ["kind", "products", "schema"], "Pages gallery authority");
  if (gallery.schema !== 1 || gallery.kind !== "kandelo-pages-vfs-product-gallery") {
    throw new Error("Pages gallery authority has unsupported identity");
  }
  const pageIds = array(pages.products, "Pages products").map((value, index) => {
    const entry = record(value, `Pages product ${index}`);
    exactKeys(entry, ["id", "load"], `Pages product ${index}`);
    if (entry.load !== "eager" && entry.load !== "lazy") {
      throw new Error(`Pages product ${index} load is invalid`);
    }
    return stableId(entry.id, `Pages product ${index} ID`);
  });
  const galleryProducts = array(gallery.products, "Pages gallery products")
    .map((value, index) => {
      const entry = record(value, `Pages gallery product ${index}`);
      exactKeys(entry, ["gallery_entries", "id", "vfs_image"], `Pages gallery product ${index}`);
      stableId(entry.vfs_image, `Pages gallery product ${index} VFS image`);
      const entries = array(entry.gallery_entries, `Pages gallery entries ${index}`)
        .map((item, itemIndex) => stableId(item, `Pages gallery entry ${index}.${itemIndex}`));
      if (!jsonEqual(entries, [...new Set(entries)].sort(ordinal))) {
        throw new Error("Pages gallery entries are not sorted and unique");
      }
      return {
        gallery_entries: entries,
        id: stableId(entry.id, `Pages gallery product ${index} ID`),
        vfs_image: stableId(entry.vfs_image, `Pages gallery product ${index} VFS image`),
      };
    });
  if (
    !jsonEqual(pageIds, [...new Set(pageIds)].sort(ordinal)) ||
    !jsonEqual(galleryProducts.map(({ id }) => id), pageIds)
  ) throw new Error("Pages gallery authority differs from the exact Pages product set");
  validateReviewedGalleryMappings(galleryProducts, presetSource, liveSetupSource);
  const files = inventoryTree(root, MAX_SITE_BYTES);
  const identity = (path: string, label: string): PagesFileIdentityV1 => {
    const selected = files.find((file) => file.path === path);
    if (selected === undefined) throw new Error(`Pages site source lacks ${label}`);
    return selected;
  };
  return {
    api: identity("api/index.html", "API entry point"),
    browser: identity("index.html", "browser entry point"),
    documentation: identity("guide/index.html", "documentation entry point"),
    files,
    kind: "kandelo-pages-site-metadata",
    products: galleryProducts,
    schema: 1,
  };
}

export interface ProductionOciAuthority extends CandidateProductDiscovery {
  fetchCanonicalOci(reference: string): Promise<CanonicalOciReadbackV1>;
  readAdmissionRecord(reference: string): Promise<JsonObject>;
}

interface ProtectedDocumentV1 {
  bytes: Uint8Array;
  path: string;
  source_bytes: Uint8Array;
  value: JsonObject;
}

export interface ProtectedPagesAuthoritiesV1 {
  catalog: ProtectedDocumentV1;
  definitions: ProtectedDocumentV1;
  gallery: JsonObject;
  liveSetupSource: string;
  pages: ProtectedDocumentV1;
  presentationSource: string;
  tests: ProtectedDocumentV1;
}

/** Test-only seam for bounded local authorities; the production CLI never exposes it. */
export interface PagesProducerTestDependenciesV1 {
  afterPrepare?(prepared: PreparedPagesProductsV1): Promise<void> | void;
  buildProduct?(request: CanonicalProductBuildRequestV1): Promise<{
    builder_report: JsonObject;
    vfs: Uint8Array;
  }>;
  /** Test-only Phase-B process seam; the production CLI always uses the fixed builder. */
  buildSite?(options: BuildFinalPagesSiteOptions): PagesSiteMetadataV1;
  collectCurrentInputs?(
    options: ResolvedProductInputCollectionOptions,
  ): JsonObject;
  createSourceReobserver?(expected: ExactSourceObservation): () => void;
  loadProtectedAuthorities?(sourceRoot: string): ProtectedPagesAuthoritiesV1;
  observeAdmissionProjection?(
    recordBytes: Uint8Array,
  ): Promise<JsonObject>;
  observeRuntime?(runtimeBundleBytes: Uint8Array, runtimeRoot: string): {
    devShellLockSha256: string;
    source: PagesProductionHandoffV1["source"];
    targetAbi: PagesProductionHandoffV1["target_abi"];
  };
  runEvidence?(request: PagesEvidenceRequestV1): Promise<JsonObject>;
  validateRegistries?(sourceRoot: string): void;
  validateAdmissionRecord?(bytes: Uint8Array): Promise<void>;
}

export async function producePagesArtifacts(
  handoffPath: string,
  outputRoot: string,
  oci: ProductionOciAuthority = createAnonymousOciAuthority(),
  testDependencies?: PagesProducerTestDependenciesV1,
  mode: "admitted" | "direct-shipping" = "admitted",
): Promise<void> {
  assertUncredentialedEnvironment(process.env);
  const handoff = validatePagesProductionHandoff(
    readCanonicalFile(handoffPath, "Pages production handoff", MAX_DOCUMENT_BYTES),
  );
  const sourceRoot = exactDirectory(handoff.source_root, "exact current-main source root");
  const tapRoot = exactDirectory(handoff.tap_root, "exact current tap-main root");
  const runtimeRoot = exactDirectory(handoff.runtime_root, "exact runtime artifact root");
  // The unpublished schema-1 handoff retains this field until the later
  // legacy-removal task. Only injected fixture dependencies may consume it;
  // the production CLI always builds Phase B from the exact source root.
  const legacyTestSiteSourceRoot = testDependencies === undefined
    ? undefined
    : exactDirectory(handoff.site_source_root, "test-only Pages site source root");
  const runtimeBundleBytes = readBoundedFile(
    handoff.runtime_bundle,
    "exact runtime bundle",
    MAX_RUNTIME_BUNDLE_BYTES,
  );
  const runtimeBundle = canonicalDocument(runtimeBundleBytes, "exact runtime bundle");
  const observedRuntime = testDependencies?.observeRuntime?.(
    runtimeBundleBytes,
    runtimeRoot,
  );
  const runtimeIdentity = observedRuntime === undefined
    ? runtimeIdentityFromBundle(runtimeBundleBytes)
    : { source: observedRuntime.source, target_abi: observedRuntime.targetAbi };
  if (
    !jsonEqual(runtimeIdentity.source, handoff.source) ||
    !jsonEqual(runtimeIdentity.target_abi, handoff.target_abi)
  ) throw new Error("exact runtime bundle differs from the protected current-main handoff");
  if (observedRuntime === undefined) {
    validateExactRuntimeArtifactRoot(runtimeBundleBytes, runtimeRoot);
  }
  const lockSha256 = observedRuntime?.devShellLockSha256 ??
    exactRuntimeDevShellLockSha256(runtimeBundleBytes);
  const sourceObservation = {
    commit: handoff.source.commit,
    devShellLockSha256: lockSha256,
    root: sourceRoot,
    tree: handoff.source.tree,
  };
  const reobserveSource = testDependencies?.createSourceReobserver?.(sourceObservation) ??
    createExactSourceReobserver(sourceObservation);
  const reobserveTap = createExactTapReobserver({
    commit: handoff.tap_source.commit,
    repository: handoff.tap_source.repository,
    root: tapRoot,
    tree: handoff.tap_source.tree,
  });

  (testDependencies?.validateRegistries ?? validateProtectedRegistries)(sourceRoot);

  const fixed = testDependencies?.loadProtectedAuthorities?.(sourceRoot) ??
    loadProtectedAuthorities(sourceRoot);
  const expectedProductIds = fixed.pages.value.products.map(({ id }: { id: string }) => id);
  if (!jsonEqual(handoff.products.map(({ id }) => id), expectedProductIds)) {
    throw new Error("production handoff products differ from the exact Pages registry");
  }
  const baseSiteMetadata = legacyTestSiteSourceRoot === undefined
    ? {
      api: { bytes: 1, path: "api/index.html", sha256: "0".repeat(64) },
      browser: { bytes: 1, path: "index.html", sha256: "0".repeat(64) },
      documentation: { bytes: 1, path: "guide/index.html", sha256: "0".repeat(64) },
      files: [],
      kind: "kandelo-pages-site-metadata" as const,
      products: structuredClone(fixed.gallery.products),
      schema: 1 as const,
    }
    : derivePagesSiteMetadata(
      legacyTestSiteSourceRoot,
      fixed.pages.value,
      fixed.gallery,
      fixed.presentationSource,
      fixed.liveSetupSource,
    );
  const output = absolutePath(outputRoot, "Pages producer output root");
  if (existsSync(output)) throw new Error("Pages producer output root already exists");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(output), `.${output.split(sep).at(-1)}.staging-`));
  const productRoots = new Map<string, string>();
  const inputBodies = new Map<string, { body: Uint8Array; identity: PagesFileIdentityV1 }>();
  const localLazyBodies = new Map<string, LocalLazyBody>();
  try {
    if (mode === "direct-shipping") {
      await produceDirectShippingTree({
        fixed,
        handoff,
        inputBodies,
        localLazyBodies,
        lockSha256,
        oci,
        output,
        reobserveSource,
        reobserveTap,
        runtimeBundle,
        sourceRoot,
        staging,
        testDependencies,
      });
      return;
    }
    const products: PagesReadinessInputV1["products"] = [];
    const collectionBlockers: Array<{
      detail: string;
      kind: string;
      product_id: string;
    }> = [];
    for (const handoffProduct of handoff.products) {
      let selected: Awaited<ReturnType<typeof discoverCandidateProductAuthority>>;
      try {
        selected = await discoverCandidateProductAuthority({
          productId: handoffProduct.id,
          source: handoff.source,
          targetAbi: handoff.target_abi,
        }, oci);
      } catch (error) {
        if (!(error instanceof PagesProductUnavailableError)) throw error;
        collectionBlockers.push({
          detail: error.message,
          kind: error.blockerKind,
          product_id: handoffProduct.id,
        });
        continue;
      }
      const candidateResolved = selected.authority.resolvedInputs;
      const currentInputRoot = join(staging, "current-inputs", handoffProduct.id);
      let currentResolved: JsonObject;
      let canonicalArtifacts: PagesReadinessInputV1["products"][number]["canonical_artifacts"];
      try {
        const collectCurrentInputs = testDependencies?.collectCurrentInputs ??
          collectProductInputObjectsFromResolvedSources;
        const inventory = collectCurrentInputs({
          archiveFiles: readStringMap(
            handoffProduct.current_inputs.archive_files,
            `${handoffProduct.id} source archives`,
          ),
          buildEnvironment: {
            devShellLockSha256: lockSha256,
            policySha256: text(runtimeBundle.build_policy_sha256, "runtime build policy"),
          },
          catalogPath: join(sourceRoot, fixed.catalog.path),
          outRoot: currentInputRoot,
          packageRoots: readStringMap(
            handoffProduct.current_inputs.package_roots,
            `${handoffProduct.id} package roots`,
          ),
          productId: handoffProduct.id,
          programIndexPath: absolutePath(
            handoffProduct.current_inputs.program_index,
            `${handoffProduct.id} program index`,
          ),
          runtimeRoot,
          source: handoff.source,
          sourceRoot,
          targetAbi: {
            snapshotSha256: handoff.target_abi.snapshot_sha256,
            version: handoff.target_abi.version,
          },
        });
        productRoots.set(handoffProduct.id, currentInputRoot);
        currentResolved = rebuildCurrentResolvedInputs(candidateResolved, inventory);
        canonicalArtifacts = [];
        for (const input of currentResolved.inputs) {
          if (
            input.kind === "homebrew-bottle" || input.kind === "product-image" ||
            input.effective_materialization !== "lazy-reference"
          ) continue;
          const object = inventory.objects.find((value: JsonObject) => value.id === input.id);
          if (object === undefined) {
            throw new Error(`${handoffProduct.id} lacks current bytes for ${input.id}`);
          }
          if (input.descriptor !== undefined) {
            throw new Error(`${input.id} requires a current-main recaptured descriptor body`);
          }
          const body = readBoundedFile(
            join(currentInputRoot, object.path),
            `${input.id} current-main input body`,
            MAX_LAZY_INPUT_BYTES,
            input.bytes,
          );
          if (sha256(body) !== input.sha256) {
            throw new Error(`${input.id} current-main input body differs from its identity`);
          }
          const path = canonicalPagesInputSitePath(input.id, input.sha256);
          const identity = { bytes: input.bytes, path, sha256: input.sha256 };
          const prior = inputBodies.get(path);
          if (prior !== undefined && !jsonEqual(prior.identity, identity)) {
            throw new Error(`canonical Pages input path ${path} has conflicting identities`);
          }
          inputBodies.set(path, { body, identity });
          const reference = canonicalPagesInputReference(input.id, input.sha256, input.bytes);
          registerLocalLazyBody(localLazyBodies, reference, {
            body,
            bytes: input.bytes,
            sha256: input.sha256,
          });
          canonicalArtifacts.push({
            bytes: input.bytes,
            input_id: input.id,
            reference,
            sha256: input.sha256,
          });
        }
      } catch (error) {
        if (!isExpectedCurrentInputUnavailable(error)) throw error;
        collectionBlockers.push({
          detail: errorMessage(error),
          kind: "current-input-unavailable",
          product_id: handoffProduct.id,
        });
        continue;
      }
      let admissions: AdmissionEnvelopeV1[];
      try {
        admissions = await discoverAdmissions(
          candidateResolved,
          handoff.target_abi.version,
          oci,
          (recordBytes) => testDependencies?.validateAdmissionRecord?.(recordBytes) ??
            validateAdmissionRecord(recordBytes, sourceRoot, staging),
          (recordBytes) => testDependencies?.observeAdmissionProjection?.(recordBytes) ??
            observeAdmissionProjection(
              recordBytes,
              tapRoot,
              handoff.tap_source,
              staging,
            ),
        );
      } catch (error) {
        if (!(error instanceof PagesProductUnavailableError)) throw error;
        collectionBlockers.push({
          detail: error.message,
          kind: error.blockerKind,
          product_id: handoffProduct.id,
        });
        continue;
      }
      products.push({
        admissions,
        candidate_builder_report: selected.authority.builderReport,
        candidate_resolved_inputs: candidateResolved as PagesReadinessInputV1["products"][number]["candidate_resolved_inputs"],
        canonical_artifacts: canonicalArtifacts,
        current_resolved_inputs: currentResolved as PagesReadinessInputV1["products"][number]["current_resolved_inputs"],
        id: handoffProduct.id,
      });
    }

    const siteMetadata = {
      ...baseSiteMetadata,
      files: [
        ...baseSiteMetadata.files,
        ...[...inputBodies.values()].map(({ identity }) => identity),
      ].sort((left: PagesFileIdentityV1, right: PagesFileIdentityV1) =>
        ordinal(left.path, right.path)),
    } as PagesReadinessInputV1["site_metadata"];
    const readinessInput: PagesReadinessInputV1 = {
      authority: {
        catalog_sha256: sha256(fixed.catalog.bytes),
        evidence_definitions_sha256: sha256(fixed.definitions.bytes),
        pages_registry_sha256: sha256(fixed.pages.bytes),
        runtime_bundle_sha256: sha256(runtimeBundleBytes),
        site_metadata_sha256: sha256(canonicalJsonBytes(siteMetadata)),
        test_registry_sha256: sha256(fixed.tests.bytes),
      },
      catalog: fixed.catalog.value as PagesReadinessInputV1["catalog"],
      evidence_definitions:
        fixed.definitions as unknown as PagesReadinessInputV1["evidence_definitions"],
      pages_registry: fixed.pages as unknown as PagesReadinessInputV1["pages_registry"],
      products,
      runtime_bundle: runtimeBundle,
      site_metadata: siteMetadata,
      source: handoff.source,
      target_abi: handoff.target_abi,
      test_registry: fixed.tests as unknown as PagesReadinessInputV1["test_registry"],
    };
    if (collectionBlockers.length > 0) {
      const heldReadiness = heldPagesReadinessRecord({
        blockers: collectionBlockers,
        pagesRegistry: {
          path: fixed.pages.path,
          products: fixed.pages.value.products,
          sha256: sha256(fixed.pages.bytes),
        },
        source: handoff.source,
        tapSource: handoff.tap_source,
        targetAbi: handoff.target_abi,
      });
      reobserveSource();
      reobserveTap();
      writeAtomicHoldOnlyOutput(staging, output, heldReadiness);
      return;
    }
    const privateProductRoot = join(staging, "sealed-products");
    mkdirSync(privateProductRoot, { mode: 0o700 });
    const prepared = await preparePagesProducts(readinessInput, {
      buildProduct: (request) => testDependencies?.buildProduct?.(request) ??
        buildCanonicalProduct(
          request,
          sourceRoot,
          productRoots.get(request.product.id)!,
          staging,
          localLazyBodies,
        ),
      fetchCanonicalOci: (reference) => oci.fetchCanonicalOci(reference),
      runEvidence: (request) => testDependencies?.runEvidence?.(request) ??
        runCanonicalEvidence(
          request,
          fixed,
          handoff,
          runtimeBundleBytes,
          runtimeRoot,
          sourceRoot,
          staging,
          localLazyBodies,
        ),
      validateAdmissionRecord: (bytes) => testDependencies?.validateAdmissionRecord?.(bytes) ??
        validateAdmissionRecord(bytes, sourceRoot, staging),
      private_product_root: privateProductRoot,
    });
    await testDependencies?.afterPrepare?.(prepared);
    let finalSiteMetadata = siteMetadata;
    let finalSiteSourceRoot = legacyTestSiteSourceRoot;
    if (prepared.blockers.length === 0) {
      const productMapPath = writeCanonical(join(staging, "private-product-map.json"), {
        kind: "kandelo-pages-private-product-map",
        products: prepared.sealed_products,
        schema: 1,
      });
      if (testDependencies?.buildSite !== undefined) {
        finalSiteSourceRoot = join(staging, "source-tree");
        finalSiteMetadata = testDependencies.buildSite({
          additionalFiles: [...inputBodies.values()].map(({ body, identity }) => ({
            ...identity,
            body,
          })),
          outputRoot: finalSiteSourceRoot,
          productMapPath,
          sourceRoot,
        });
      } else if (testDependencies === undefined) {
        finalSiteSourceRoot = join(staging, "source-tree");
        finalSiteMetadata = buildFinalPagesSite({
          additionalFiles: [...inputBodies.values()].map(({ body, identity }) => ({
            ...identity,
            body,
          })),
          outputRoot: finalSiteSourceRoot,
          productMapPath,
          sourceRoot,
        });
      }
      rmSync(productMapPath, { force: true });
    }
    readinessInput.site_metadata = finalSiteMetadata;
    readinessInput.authority.site_metadata_sha256 = sha256(canonicalJsonBytes(finalSiteMetadata));
    const result = finalizePagesReadiness(readinessInput, prepared, finalSiteMetadata);
    bindAdmissionProjections(result as unknown as JsonObject, products, handoff.tap_source);
    writeCanonical(join(staging, "readiness.json"), result.readiness);
    if (!result.readiness.ready) {
      reobserveSource();
      reobserveTap();
      writeAtomicHoldOnlyOutput(staging, output, result.readiness);
      return;
    }
    if (result.readiness.ready) {
      if (result.site_manifest === undefined || result.artifacts === undefined) {
        throw new Error("ready Pages result lacks canonical artifacts");
      }
      writeCanonical(join(staging, "site-manifest.json"), result.site_manifest);
      writeReadyArtifacts(staging, result.artifacts);
      assembleSourceTree(
        staging,
        finalSiteSourceRoot!,
        result.site_manifest,
        result.artifacts,
        inputBodies,
      );
    }
    rmSync(privateProductRoot, { force: true, recursive: true });
    reobserveSource();
    reobserveTap();
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
}

export async function shipPagesArtifacts(
  handoffPath: string,
  outputRoot: string,
  oci: ProductionOciAuthority = createAnonymousOciAuthority(),
  testDependencies?: PagesProducerTestDependenciesV1,
): Promise<void> {
  await producePagesArtifacts(
    handoffPath,
    outputRoot,
    oci,
    testDependencies,
    "direct-shipping",
  );
}

interface DirectBottleInputV1 {
  descriptor: { body: Uint8Array; bytes: number; reference: string; sha256: string };
  layer: { body: Uint8Array; bytes: number; reference: string; sha256: string };
}

async function produceDirectShippingTree(options: {
  fixed: ProtectedPagesAuthoritiesV1;
  handoff: PagesProductionHandoffV1;
  inputBodies: Map<string, { body: Uint8Array; identity: PagesFileIdentityV1 }>;
  localLazyBodies: Map<string, LocalLazyBody>;
  lockSha256: string;
  oci: ProductionOciAuthority;
  output: string;
  reobserveSource: () => void;
  reobserveTap: () => void;
  runtimeBundle: JsonObject;
  sourceRoot: string;
  staging: string;
  testDependencies?: PagesProducerTestDependenciesV1;
}): Promise<void> {
  // This is the deliberately narrow shipping path. Canonical public bottles
  // and the current product manifests are sufficient authority here; richer
  // candidate/admission evidence remains on the asynchronous producer path.
  const catalogEntries = new Map(
    array(options.fixed.catalog.value.products, "direct product catalog")
      .map((value) => {
        const entry = record(value, "direct product catalog entry");
        return [stableId(entry.manifest?.id, "direct product ID"), entry] as const;
      }),
  );
  const pageEntries = array(options.fixed.pages.value.products, "direct Pages products")
    .map((value) => {
      const entry = record(value, "direct Pages product");
      return {
        id: stableId(entry.id, "direct Pages product ID"),
        load: entry.load as "eager" | "lazy",
      };
    });
  const expectedIds = new Set(pageEntries.map(({ id }) => id));
  const inventories = new Map<string, JsonObject>();
  const productRoots = new Map<string, string>();
  for (const handoffProduct of options.handoff.products) {
    const entry = catalogEntries.get(handoffProduct.id);
    if (entry === undefined) throw new Error(`${handoffProduct.id} lacks a current product manifest`);
    const currentInputRoot = join(options.staging, "current-inputs", handoffProduct.id);
    const collect = options.testDependencies?.collectCurrentInputs ??
      collectProductInputObjectsFromResolvedSources;
    const inventory = collect({
      archiveFiles: readStringMap(
        handoffProduct.current_inputs.archive_files,
        `${handoffProduct.id} source archives`,
      ),
      buildEnvironment: {
        devShellLockSha256: options.lockSha256,
        policySha256: text(options.runtimeBundle.build_policy_sha256, "runtime build policy"),
      },
      catalogPath: join(options.sourceRoot, options.fixed.catalog.path),
      outRoot: currentInputRoot,
      packageRoots: readStringMap(
        handoffProduct.current_inputs.package_roots,
        `${handoffProduct.id} package roots`,
      ),
      productId: handoffProduct.id,
      programIndexPath: absolutePath(
        handoffProduct.current_inputs.program_index,
        `${handoffProduct.id} program index`,
      ),
      runtimeRoot: options.handoff.runtime_root,
      source: options.handoff.source,
      sourceRoot: options.sourceRoot,
      targetAbi: {
        snapshotSha256: options.handoff.target_abi.snapshot_sha256,
        version: options.handoff.target_abi.version,
      },
    }) as unknown as JsonObject;
    inventories.set(handoffProduct.id, inventory);
    productRoots.set(handoffProduct.id, currentInputRoot);
  }

  const embedded = new Set<string>();
  for (const [id, inventory] of inventories) {
    for (const value of array(inventory.objects, `${id} direct input objects`)) {
      const input = record(value, `${id} direct input object`);
      if (input.role === "runtime" && input.declared_materialization === "embedded") {
        embedded.add(directObjectKey(input));
      }
    }
    const manifest = record(catalogEntries.get(id)!.manifest, `${id} manifest`);
    for (const claimValue of array(manifest.software?.homebrew ?? [], `${id} Homebrew claims`)) {
      const claim = record(claimValue, `${id} Homebrew claim`);
      if (claim.materialization !== "embedded") continue;
      for (const formula of array(claim.formulae, `${id} Homebrew Formulae`)) {
        embedded.add(`homebrew:${stableId(formula, `${id} Homebrew Formula`)}`);
      }
    }
  }

  const builtProducts = new Map<string, {
    bytes: number;
    id: string;
    reference: string;
    sha256: string;
    vfs: Uint8Array;
  }>();
  const sealedProducts: Array<{
    bytes: number;
    id: string;
    load: "eager" | "lazy";
    path: string;
    private_path: string;
    sha256: string;
  }> = [];
  const bottleCache = new Map<string, DirectBottleInputV1>();
  const order = directProductOrder(pageEntries.map(({ id }) => id), catalogEntries);
  for (const id of order) {
    const entry = catalogEntries.get(id)!;
    const manifest = record(entry.manifest, `${id} direct manifest`);
    const inventory = inventories.get(id)!;
    const inputRoot = productRoots.get(id)!;
    const inputs: JsonObject[] = [];
    for (const value of array(inventory.objects, `${id} direct input objects`)) {
      const object = record(value, `${id} direct input object`);
      const effective = directEffectivePlacement(object, embedded.has(directObjectKey(object)));
      const input: JsonObject = {
        architecture: object.architecture,
        bytes: object.bytes,
        declared_materialization: object.declared_materialization,
        effective_materialization: effective,
        id: object.id,
        kind: object.kind,
        role: object.role,
        sha256: object.sha256,
        ...(effective === "lazy-reference"
          ? { reference: canonicalPagesInputReference(object.id, object.sha256, object.bytes) }
          : { path: object.path }),
      };
      inputs.push(input);
      if (effective === "lazy-reference") {
        const body = readBoundedFile(
          join(inputRoot, object.path),
          `${object.id} direct lazy input`,
          MAX_LAZY_INPUT_BYTES,
          object.bytes,
        );
        if (sha256(body) !== object.sha256) {
          throw new Error(`${object.id} direct lazy input differs from its identity`);
        }
        const path = canonicalPagesInputSitePath(object.id, object.sha256);
        const identity = { bytes: object.bytes, path, sha256: object.sha256 };
        const prior = options.inputBodies.get(path);
        if (prior !== undefined && !jsonEqual(prior.identity, identity)) {
          throw new Error(`direct Pages input path ${path} has conflicting identities`);
        }
        options.inputBodies.set(path, { body, identity });
        registerLocalLazyBody(options.localLazyBodies, input.reference, {
          body,
          bytes: object.bytes,
          sha256: object.sha256,
        });
      }
    }

    const canonicalHomebrewLayers: CanonicalProductBuildRequestV1["canonical_homebrew_layers"] = [];
    const canonicalHomebrewDescriptors:
      CanonicalProductBuildRequestV1["canonical_homebrew_descriptors"] = [];
    for (const claimValue of array(manifest.software?.homebrew ?? [], `${id} Homebrew claims`)) {
      const claim = record(claimValue, `${id} Homebrew claim`);
      for (const formulaValue of array(claim.formulae, `${id} Homebrew Formulae`)) {
        const formula = stableId(formulaValue, `${id} Homebrew Formula`);
        let bottle = bottleCache.get(formula);
        if (bottle === undefined) {
          bottle = await readDirectCanonicalBottle(
            formula,
            options.handoff.target_abi.version,
            options.oci,
          );
          bottleCache.set(formula, bottle);
        }
        const inputId = `homebrew-${formula}`;
        const declared = claim.materialization;
        const effective = directEffectivePlacement(
          { declared_materialization: declared, role: "runtime" },
          embedded.has(`homebrew:${formula}`),
        );
        inputs.push({
          architecture: manifest.architecture,
          bytes: bottle.layer.bytes,
          declared_materialization: declared,
          descriptor: {
            bytes: bottle.descriptor.bytes,
            path: `inputs/objects/${inputId}-metadata-sha256-${bottle.descriptor.sha256}`,
            reference: bottle.descriptor.reference,
            sha256: bottle.descriptor.sha256,
          },
          effective_materialization: effective,
          id: inputId,
          kind: "homebrew-bottle",
          ...(effective === "lazy-reference"
            ? { reference: bottle.layer.reference }
            : {
              path: `inputs/objects/${inputId}-sha256-${bottle.layer.sha256}`,
              reference: bottle.layer.reference,
            }),
          role: "runtime",
          sha256: bottle.layer.sha256,
        });
        canonicalHomebrewLayers.push({
          body: bottle.layer.body,
          bytes: bottle.layer.bytes,
          input_id: inputId,
          sha256: bottle.layer.sha256,
        });
        canonicalHomebrewDescriptors.push({
          body: bottle.descriptor.body,
          bytes: bottle.descriptor.bytes,
          input_id: inputId,
          reference: bottle.descriptor.reference,
          sha256: bottle.descriptor.sha256,
        });
      }
    }

    const canonicalProductInputs: CanonicalProductBuildRequestV1["canonical_product_inputs"] = [];
    for (const claimValue of array(manifest.composition?.product ?? [], `${id} product claims`)) {
      const claim = record(claimValue, `${id} product claim`);
      const dependency = stableId(claim.id, `${id} product dependency`);
      const built = builtProducts.get(dependency);
      if (built === undefined) throw new Error(`${id} depends on unavailable direct product ${dependency}`);
      const effective = directEffectivePlacement(
        { declared_materialization: claim.materialization, role: "runtime" },
        claim.materialization === "embedded",
      );
      inputs.push({
        architecture: manifest.architecture,
        bytes: built.bytes,
        declared_materialization: claim.materialization,
        effective_materialization: effective,
        id: `product-${dependency}`,
        kind: "product-image",
        ...(effective === "lazy-reference"
          ? { reference: built.reference }
          : {
            path: `inputs/objects/product-${dependency}-sha256-${built.sha256}`,
            reference: built.reference,
          }),
        role: "runtime",
        sha256: built.sha256,
      });
      canonicalProductInputs.push(built);
    }
    inputs.sort((left, right) => ordinal(left.id, right.id));
    const product = {
      architecture: manifest.architecture,
      id,
      manifest,
      manifest_path: entry.path,
      manifest_sha256: entry.sha256,
      output: manifest.output,
    };
    const resolvedInputs = {
      build_environment: structuredClone(inventory.build_environment),
      inputs,
      kind: "kandelo-resolved-vfs-product-inputs",
      product: {
        architecture: product.architecture,
        id,
        manifest_path: product.manifest_path,
        manifest_sha256: product.manifest_sha256,
        output: product.output,
      },
      reference_class: "canonical",
      schema: 1,
      source: structuredClone(options.handoff.source),
      target_abi: structuredClone(options.handoff.target_abi),
    } as unknown as PagesReadinessInputV1["products"][number]["current_resolved_inputs"];
    const built = await (
      options.testDependencies?.buildProduct?.({
        canonical_homebrew_descriptors: canonicalHomebrewDescriptors,
        canonical_homebrew_layers: canonicalHomebrewLayers,
        canonical_product_inputs: canonicalProductInputs,
        product,
        resolved_inputs: resolvedInputs,
      }) ?? buildCanonicalProduct(
        {
          canonical_homebrew_descriptors: canonicalHomebrewDescriptors,
          canonical_homebrew_layers: canonicalHomebrewLayers,
          canonical_product_inputs: canonicalProductInputs,
          product,
          resolved_inputs: resolvedInputs,
        },
        options.sourceRoot,
        inputRoot,
        options.staging,
        options.localLazyBodies,
      )
    );
    validateDirectBuild(product, resolvedInputs, built);
    const vfs = new Uint8Array(built.vfs);
    const vfsSha256 = sha256(vfs);
    const reference = directProductReference(
      options.handoff.target_abi.version,
      id,
      vfsSha256,
      vfs.byteLength,
    );
    const exact = { bytes: vfs.byteLength, id, reference, sha256: vfsSha256, vfs };
    builtProducts.set(id, exact);
    const privatePath = join(options.staging, "sealed-products", `${id}.vfs.zst`);
    mkdirSync(dirname(privatePath), { recursive: true, mode: 0o700 });
    writeFileSync(privatePath, vfs, { flag: "wx", mode: 0o600 });
    const page = pageEntries.find((value) => value.id === id)!;
    sealedProducts.push({
      bytes: vfs.byteLength,
      id,
      load: page.load,
      path: directProductSitePath(id, vfsSha256, options.handoff.target_abi.version),
      private_path: privatePath,
      sha256: vfsSha256,
    });
  }
  sealedProducts.sort((left, right) => ordinal(left.id, right.id));
  if (!jsonEqual(sealedProducts.map(({ id }) => id), [...expectedIds].sort(ordinal))) {
    throw new Error("direct shipping did not build the exact Pages product set");
  }
  const productMapPath = writeCanonical(join(options.staging, "private-product-map.json"), {
    kind: "kandelo-pages-private-product-map",
    products: sealedProducts,
    schema: 1,
  });
  const sourceTree = join(options.staging, "source-tree");
  const siteMetadata = options.testDependencies?.buildSite?.({
    additionalFiles: [...options.inputBodies.values()].map(({ body, identity }) => ({
      ...identity,
      body,
    })),
    outputRoot: sourceTree,
    productMapPath,
    sourceRoot: options.sourceRoot,
  }) ?? buildFinalPagesSite({
    additionalFiles: [...options.inputBodies.values()].map(({ body, identity }) => ({
      ...identity,
      body,
    })),
    outputRoot: sourceTree,
    productMapPath,
    sourceRoot: options.sourceRoot,
  });
  const deployment = {
    files: siteMetadata.files,
    kind: "kandelo-pages-site-manifest",
    products: sealedProducts.map(({ id, load, path, bytes, sha256: digestValue }) => ({
      id,
      load,
      path,
      vfs_bytes: bytes,
      vfs_sha256: digestValue,
    })),
    schema: 1,
    shipping_mode: "direct-canonical-bottles",
    source: structuredClone(options.handoff.source),
    target_abi: structuredClone(options.handoff.target_abi),
  };
  mkdirSync(join(sourceTree, ".well-known/kandelo"), { recursive: true, mode: 0o755 });
  writeCanonical(join(sourceTree, ".well-known/kandelo/pages-deployment.json"), deployment);
  for (const name of readdirSync(options.staging)) {
    if (name !== "source-tree") {
      rmSync(join(options.staging, name), { force: true, recursive: true });
    }
  }
  options.reobserveSource();
  options.reobserveTap();
  renameSync(options.staging, options.output);
}

function directObjectKey(input: JsonObject): string {
  return `${String(input.kind)}:${String(input.sha256)}:${String(input.bytes)}`;
}

function directEffectivePlacement(
  input: JsonObject,
  globallyEmbedded: boolean,
): "build-only" | "embedded" | "lazy-reference" {
  if (input.role === "build") return "build-only";
  if (input.role !== "runtime") throw new Error("direct input has unsupported role");
  if (input.declared_materialization === "embedded" || globallyEmbedded) return "embedded";
  if (input.declared_materialization === "lazy") return "lazy-reference";
  throw new Error("direct input has unsupported materialization");
}

function directProductOrder(ids: string[], catalog: Map<string, JsonObject>): string[] {
  const selected = new Set(ids);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("direct Pages product graph contains a cycle");
    const entry = catalog.get(id);
    if (entry === undefined) throw new Error(`${id} lacks a direct product manifest`);
    visiting.add(id);
    for (const value of array(entry.manifest?.composition?.product ?? [], `${id} dependencies`)) {
      const dependency = stableId(record(value, `${id} dependency`).id, `${id} dependency ID`);
      if (!selected.has(dependency)) {
        throw new Error(`${id} depends on non-Pages product ${dependency}`);
      }
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };
  [...ids].sort(ordinal).forEach(visit);
  return order;
}

async function readDirectCanonicalBottle(
  formula: string,
  abi: number,
  oci: ProductionOciAuthority,
): Promise<DirectBottleInputV1> {
  const admissionRepository =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${abi}/${formula}/admissions`;
  const references = (await oci.listImmutableReferences(admissionRepository)).sort(ordinal);
  const matches: Array<{ record: JsonObject; reference: string }> = [];
  for (const reference of references) {
    const value = await oci.readAdmissionRecord(reference);
    if (
      value.admission?.formula_metadata_update?.formula === formula &&
      value.admission?.formula_metadata_update?.target_abi === abi
    ) matches.push({ record: value, reference });
  }
  if (matches.length === 0) throw new Error(`${formula} lacks a canonical ABI ${abi} bottle`);
  const firstIdentity = admissionProductIdentity(matches[0]!.record);
  if (matches.some(({ record: value }) => !jsonEqual(admissionProductIdentity(value), firstIdentity))) {
    throw new Error(`${formula} has conflicting canonical ABI ${abi} bottles`);
  }
  const recordValue = matches[0]!.record;
  const canonical = record(recordValue.admission?.canonical, `${formula} canonical bottle`);
  const canonicalReference = text(canonical.immutable_reference, `${formula} canonical reference`);
  const readback = await oci.fetchCanonicalOci(canonicalReference);
  if (
    sha256(readback.manifest) !== canonical.sha256 ||
    readback.manifest.byteLength !== canonical.bytes
  ) throw new Error(`${formula} canonical manifest differs from its public record`);
  const manifest = record(canonicalDocument(readback.manifest, `${formula} canonical manifest`),
    `${formula} canonical manifest`);
  const layers = array(manifest.layers, `${formula} canonical layers`)
    .map((value) => record(value, `${formula} canonical layer`));
  const layer = directOciLayer(layers, "bottle-layer", `${formula} bottle layer`);
  const descriptor = directOciLayer(
    layers,
    "vfs-composition-descriptor",
    `${formula} VFS composition descriptor`,
  );
  const promoted = record(recordValue.admission?.promoted_layer, `${formula} promoted layer`);
  if (
    layer.sha256 !== promoted.sha256 || layer.bytes !== promoted.bytes ||
    readback.bottle_layer.byteLength !== layer.bytes ||
    sha256(readback.bottle_layer) !== layer.sha256 ||
    readback.vfs_composition_descriptor.byteLength !== descriptor.bytes ||
    sha256(readback.vfs_composition_descriptor) !== descriptor.sha256
  ) throw new Error(`${formula} canonical bottle bodies differ from their public identities`);
  const repository = canonicalReference.replace(/@sha256:[0-9a-f]{64}$/u, "");
  if (repository === canonicalReference) throw new Error(`${formula} canonical reference is mutable`);
  return {
    descriptor: {
      body: new Uint8Array(readback.vfs_composition_descriptor),
      bytes: descriptor.bytes,
      reference: `${repository}@sha256:${descriptor.sha256}`,
      sha256: descriptor.sha256,
    },
    layer: {
      body: new Uint8Array(readback.bottle_layer),
      bytes: layer.bytes,
      reference: `${repository}@sha256:${layer.sha256}`,
      sha256: layer.sha256,
    },
  };
}

function directOciLayer(
  layers: JsonObject[],
  role: string,
  label: string,
): { bytes: number; sha256: string } {
  const matches = layers.filter((value) =>
    record(value.annotations, `${label} annotations`)["dev.kandelo.abi-staging.role"] === role);
  if (matches.length !== 1) throw new Error(`${label} is not unique`);
  const selected = matches[0]!;
  const digestValue = text(selected.digest, `${label} digest`);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digestValue)) throw new Error(`${label} digest is invalid`);
  if (!Number.isSafeInteger(selected.size) || selected.size < 1) {
    throw new Error(`${label} byte size is invalid`);
  }
  return { bytes: selected.size, sha256: digestValue.slice(7) };
}

function directProductSitePath(id: string, digestValue: string, abi: number): string {
  return `products/${id}/sha256-${digestValue}/${id}-${abi}.vfs.zst`;
}

function directProductReference(
  abi: number,
  id: string,
  digestValue: string,
  bytes: number,
): string {
  return `https://automattic.github.io/kandelo/${directProductSitePath(id, digestValue, abi)}` +
    `?sha256=${digestValue}&bytes=${bytes}`;
}

function validateDirectBuild(
  product: JsonObject,
  resolved: JsonObject,
  built: { builder_report: JsonObject; vfs: Uint8Array },
): void {
  if (!(built.vfs instanceof Uint8Array) || built.vfs.byteLength < 1) {
    throw new Error(`${product.id} direct builder returned no VFS bytes`);
  }
  const output = record(built.builder_report.output, `${product.id} direct builder output`);
  if (
    built.builder_report.kind !== "kandelo-vfs-builder-report" ||
    built.builder_report.schema !== 1 ||
    built.builder_report.capture?.complete !== true ||
    !jsonEqual(built.builder_report.capture?.unreported_reads, []) ||
    built.builder_report.resolved_inputs_sha256 !== sha256(canonicalJsonBytes(resolved)) ||
    !jsonEqual(built.builder_report.product, resolved.product) ||
    output.bytes !== built.vfs.byteLength || output.sha256 !== sha256(built.vfs) ||
    output.name !== product.output || output.path !== product.output
  ) throw new Error(`${product.id} direct builder report differs from its output`);
}

type ProtectedAuthorities = ProtectedPagesAuthoritiesV1;

function loadProtectedAuthorities(sourceRoot: string): ProtectedPagesAuthoritiesV1 {
  const load = (repositoryPath: string, label: string) => {
    const path = join(sourceRoot, repositoryPath);
    const bytes = readBoundedFile(path, label, MAX_DOCUMENT_BYTES);
    return { path: repositoryPath, source_bytes: bytes, bytes, value: canonicalDocument(bytes, label) };
  };
  const pages = load(
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
    "Pages product registry",
  );
  const sourcePages = readPagesRegistry(join(
    sourceRoot,
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
  ));
  if (!jsonEqual(sourcePages, pages.value)) {
    throw new Error("source and generated Pages registries differ");
  }
  return {
    catalog: load("images/vfs/products/generated/catalog.json", "VFS product catalog"),
    definitions: load(
      "abi/staging/evidence-definitions.generated.json",
      "evidence definitions",
    ),
    gallery: load(
      "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json",
      "Pages product gallery",
    ).value,
    pages,
    tests: load("tests/vfs-products.generated.json", "test product registry"),
    presentationSource: new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(
      join(sourceRoot, "apps/browser-demos/pages/kandelo/presets.ts"),
      "reviewed preset authority",
      MAX_DOCUMENT_BYTES,
    )),
    liveSetupSource: new TextDecoder("utf-8", { fatal: true }).decode(readBoundedFile(
      join(sourceRoot, "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts"),
      "reviewed live-demo authority",
      MAX_DOCUMENT_BYTES,
    )),
  };
}

function validateReviewedGalleryMappings(
  products: Array<{ gallery_entries: string[]; id: string; vfs_image: string }>,
  presetSource: string,
  liveSetupSource: string,
): void {
  if (typeof presetSource !== "string" || typeof liveSetupSource !== "string") {
    throw new Error("Pages gallery lacks reviewed presentation authorities");
  }
  const presetStart = presetSource.indexOf("export const PRESET_LIBRARY");
  const presetEnd = presetSource.indexOf("\n];", presetStart);
  if (presetStart < 0 || presetEnd < 0) {
    throw new Error("reviewed preset authority is not static");
  }
  const presetIds = [...presetSource.slice(presetStart, presetEnd).matchAll(
    /^\s{4}id: "([a-z0-9-]+)",$/gmu,
  )].map((match) => match[1]!);
  if (!jsonEqual(presetIds, [...new Set(presetIds)])) {
    throw new Error("reviewed preset authority contains duplicate IDs");
  }
  const liveStart = liveSetupSource.indexOf("const LIVE_DEMO_SPECS");
  const liveEnd = liveSetupSource.indexOf("\n};", liveStart);
  if (liveStart < 0 || liveEnd < 0) {
    throw new Error("reviewed live-demo authority is not static");
  }
  const imageByEntry = new Map(
    [...liveSetupSource.slice(liveStart, liveEnd).matchAll(
      /^\s{2}(?:"([a-z0-9-]+)"|([a-z0-9-]+)): \{\n\s{4}image: "([a-z0-9-]+)",$/gmu,
    )].map((match) => [match[1] ?? match[2]!, match[3]!]),
  );
  const declaredEntries = products.flatMap(({ gallery_entries }) => gallery_entries).sort(ordinal);
  if (!jsonEqual(declaredEntries, [...presetIds].sort(ordinal))) {
    throw new Error("Pages gallery entries differ from the reviewed preset authority");
  }
  for (const product of products) {
    for (const entry of product.gallery_entries) {
      if (imageByEntry.get(entry) !== product.vfs_image) {
        throw new Error(
          `Pages gallery entry ${entry} does not use its reviewed VFS image ${product.vfs_image}`,
        );
      }
    }
  }
}

function readStringMap(path: string, label: string): Record<string, string> {
  const value = readCanonicalFile(path, label, MAX_DOCUMENT_BYTES);
  const selected = record(value, label);
  if (Object.keys(selected).length > 4_096) throw new Error(`${label} exceeds its item bound`);
  return Object.fromEntries(Object.entries(selected).map(([key, pathValue]) => [
    stableId(key, `${label} key`),
    absolutePath(pathValue, `${label} ${key}`),
  ]));
}

export async function discoverAdmissions(
  candidateResolved: JsonObject,
  abi: number,
  oci: ProductionOciAuthority,
  validateRecord?: (bytes: Uint8Array) => Promise<void>,
  observeProjection?: (bytes: Uint8Array) => Promise<JsonObject>,
): Promise<AdmissionEnvelopeV1[]> {
  const formulas = array(candidateResolved.inputs, "candidate inputs")
    .filter((value) => record(value, "candidate input").kind === "homebrew-bottle")
    .map((value) => {
      const input = record(value, "Homebrew candidate input");
      const id = stableId(input.id, "Homebrew candidate input ID");
      if (!id.startsWith("homebrew-")) throw new Error(`${id} lacks a Formula identity`);
      return { formula: stableId(id.slice(9), `${id} Formula`), input };
    });
  const admissions: AdmissionEnvelopeV1[] = [];
  for (const { formula, input } of formulas) {
    const repository =
      `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${abi}/${formula}/admissions`;
    const references = await oci.listImmutableReferences(repository);
    if (references.length > MAX_OCI_TAGS) throw new Error(`${formula} admissions exceed their bound`);
    const matching: AdmissionEnvelopeV1[] = [];
    for (const reference of references) {
      const locator = immutableOciReference(reference, `${formula} admission reference`);
      if (locator.repository !== repository) {
        throw new Error(`${formula} admission reference leaves its exact repository`);
      }
      const recordValue = await oci.readAdmissionRecord(reference);
      if (
        recordValue.admission?.formula_metadata_update?.formula !== formula ||
        recordValue.admission?.formula_metadata_update?.target_abi !== abi ||
        recordValue.admission?.promoted_layer?.sha256 !== input.sha256 ||
        recordValue.admission?.promoted_layer?.bytes !== input.bytes
      ) continue;
      const recordBytes = canonicalJsonBytes(recordValue);
      if (validateRecord !== undefined) await validateRecord(recordBytes);
      const recordSha256 = sha256(recordBytes);
      matching.push({
        immutable_reference: reference,
        record: recordValue,
        record_sha256: recordSha256,
      });
    }
    if (matching.length === 0) {
      throw new PagesProductUnavailableError(
        "missing-admission",
        `${formula} lacks an immutable admission record for its canonical layer`,
      );
    }
    const expectedIdentity = admissionProductIdentity(matching[0]!.record);
    if (matching.some(({ record: value }) =>
      !jsonEqual(admissionProductIdentity(value), expectedIdentity))) {
      throw new Error(`${formula} has conflicting immutable admission records`);
    }
    matching.sort((left, right) => ordinal(left.record_sha256, right.record_sha256));
    const selected = matching[0]!;
    if (observeProjection === undefined) {
      throw new Error(`${formula} selected admission lacks a current-main projection observer`);
    }
    const projection = validateAdmissionProjectionObservation(
      await observeProjection(canonicalJsonBytes(selected.record)),
      selected.record,
      selected.record_sha256,
    );
    admissions.push({ ...selected, projection } as AdmissionEnvelopeV1);
  }
  return admissions.sort((left, right) => ordinal(left.record_sha256, right.record_sha256));
}

function validateAdmissionProjectionObservation(
  value: unknown,
  admissionRecord: JsonObject,
  recordSha256: string,
): JsonObject {
  const projection = record(value, "current admission projection");
  exactKeys(projection, [
    "admission_record_sha256", "architecture", "formula",
    "formula_metadata_update_sha256", "kind", "projection_sha256", "schema",
    "tap_source", "target_abi",
  ], "current admission projection");
  const update = record(
    admissionRecord.admission?.formula_metadata_update,
    "admission Formula metadata update",
  );
  const source = record(projection.tap_source, "current admission projection tap source");
  exactKeys(source, ["commit", "repository", "tree"],
    "current admission projection tap source");
  if (
    projection.schema !== 1 || projection.kind !== "kandelo-pages-admission-projection" ||
    projection.admission_record_sha256 !== recordSha256 ||
    projection.formula_metadata_update_sha256 !== sha256(canonicalJsonBytes(update)) ||
    projection.formula !== update.formula || projection.architecture !== update.architecture ||
    projection.target_abi !== update.target_abi || !SHA256.test(projection.projection_sha256) ||
    source.repository !== PROTECTED_TAP_REPOSITORY ||
    !/^[0-9a-f]{40}$/u.test(source.commit) || !/^[0-9a-f]{40}$/u.test(source.tree)
  ) throw new Error("current admission projection differs from its selected admission");
  return projection;
}

export function bindAdmissionProjections(
  result: JsonObject,
  products: PagesReadinessInputV1["products"],
  tapSource: PagesProductionHandoffV1["tap_source"],
): void {
  const readiness = record(result.readiness, "computed Pages readiness");
  readiness.tap_source = structuredClone(tapSource);
  if (readiness.ready !== true) return;
  const selectedByProduct = new Map(products.map((product) => [product.id, product.admissions]));
  const globallyObserved = new Map<string, JsonObject>();
  for (const readyProduct of array(readiness.products, "ready Pages products")) {
    const product = record(readyProduct, "ready Pages product");
    const selected = selectedByProduct.get(product.id);
    if (selected === undefined) throw new Error(`${String(product.id)} lacks selected admissions`);
    const byRecord = new Map(selected.map((admission: any) => [
      admission.record_sha256,
      admission.projection,
    ]));
    const seen = new Set<string>();
    product.admissions = array(product.admissions, `${String(product.id)} readiness admissions`)
      .map((value) => {
        const admission = record(value, `${String(product.id)} readiness admission`);
        const projection = byRecord.get(admission.record_sha256);
        if (projection === undefined) {
          throw new Error(`${String(product.id)} admission lacks a current-main projection`);
        }
        const identity = `${String(projection.formula)}\0${String(projection.architecture)}`;
        if (seen.has(identity)) {
          throw new Error(`${String(product.id)} has duplicate Formula/architecture projections`);
        }
        seen.add(identity);
        const prior = globallyObserved.get(identity);
        if (prior !== undefined && !jsonEqual(prior, projection)) {
          throw new Error(`selected admissions have conflicting current projections for ${identity}`);
        }
        globallyObserved.set(identity, projection);
        return { ...admission, projection };
      });
  }
  const siteManifest = record(result.site_manifest, "computed Pages site manifest");
  siteManifest.tap_source = structuredClone(tapSource);
  const readyById = new Map(
    array(readiness.products, "ready Pages products").map((value) => {
      const product = record(value, "ready Pages product");
      return [product.id, product] as const;
    }),
  );
  for (const value of array(siteManifest.products, "Pages site products")) {
    const product = record(value, "Pages site product");
    const ready = readyById.get(product.id);
    if (ready === undefined) throw new Error(`${String(product.id)} site product lacks readiness`);
    product.admissions = structuredClone(ready.admissions);
  }
  siteManifest.readiness_record_sha256 = sha256(canonicalJsonBytes(readiness));
}

function admissionProductIdentity(value: JsonObject): JsonObject {
  const admission = record(value.admission, "admission product identity");
  const update = record(
    admission.formula_metadata_update,
    "admission Formula metadata identity",
  );
  return {
    canonical: admission.canonical,
    formula_metadata_update: {
      bottle_layer_bytes: update.bottle_layer_bytes,
      bottle_layer_sha256: update.bottle_layer_sha256,
      canonical_manifest_digest: update.canonical_manifest_digest,
      formula: update.formula,
      target_abi: update.target_abi,
    },
    promoted_layer: {
      bytes: admission.promoted_layer?.bytes,
      sha256: admission.promoted_layer?.sha256,
    },
  };
}

async function buildCanonicalProduct(
  request: CanonicalProductBuildRequestV1,
  sourceRoot: string,
  inputRoot: string,
  staging: string,
  localLazyBodies: Map<string, LocalLazyBody>,
): Promise<{ builder_report: JsonObject; vfs: Uint8Array }> {
  const byId = new Map(request.resolved_inputs.inputs.map((input: JsonObject) => [input.id, input]));
  for (const layer of request.canonical_homebrew_layers) {
    const input = byId.get(layer.input_id);
    registerLocalLazyBody(
      localLazyBodies,
      text(input?.reference, `${layer.input_id} canonical reference`),
      { body: layer.body, bytes: layer.bytes, sha256: layer.sha256 },
    );
    if (input?.effective_materialization !== "lazy-reference") {
      writeExactInput(inputRoot, input?.path, layer.body, `${layer.input_id} bottle layer`);
    }
  }
  for (const descriptor of request.canonical_homebrew_descriptors) {
    const input = byId.get(descriptor.input_id);
    writeExactInput(
      inputRoot,
      input?.descriptor?.path,
      descriptor.body,
      `${descriptor.input_id} composition descriptor`,
    );
  }
  for (const product of request.canonical_product_inputs) {
    const input = byId.get(`product-${product.id}`);
    registerLocalLazyBody(localLazyBodies, product.reference, {
      body: product.vfs,
      bytes: product.bytes,
      sha256: product.sha256,
    });
    if (input?.effective_materialization !== "lazy-reference") {
      writeExactInput(inputRoot, input?.path, product.vfs, `${product.id} product image`);
    }
  }
  const inputsPath = join(inputRoot, "resolved-inputs.json");
  writeFileSync(inputsPath, canonicalJsonBytes(request.resolved_inputs), { flag: "wx", mode: 0o600 });
  const workDir = join(staging, "builds", request.product.id);
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  const outputPath = join(workDir, request.product.output);
  const reportPath = join(workDir, "builder-report.json");
  await runVfsProductBuilderCli([
    "--inputs", inputsPath,
    "--manifest", join(sourceRoot, request.product.manifest_path),
    "--output", outputPath,
    "--report", reportPath,
    "--work-dir", workDir,
  ]);
  return {
    builder_report: readCanonicalFile(reportPath, "canonical builder report", MAX_DOCUMENT_BYTES),
    vfs: readBoundedFile(outputPath, "canonical VFS image", MAX_VFS_BYTES),
  };
}

function registerLocalLazyBody(
  bodies: Map<string, LocalLazyBody>,
  reference: string,
  exact: LocalLazyBody,
): void {
  if (
    exact.body.byteLength !== exact.bytes || exact.bytes < 1 ||
    exact.bytes > MAX_LAZY_INPUT_BYTES || sha256(exact.body) !== exact.sha256
  ) throw new Error(`local lazy body ${reference} differs from its exact identity`);
  const prior = bodies.get(reference);
  if (prior !== undefined && (
    prior.bytes !== exact.bytes || prior.sha256 !== exact.sha256 ||
    !bytesEqual(prior.body, exact.body)
  )) throw new Error(`local lazy body ${reference} has conflicting identities`);
  if (prior === undefined) bodies.set(reference, exact);
}

function writeExactInput(
  inputRoot: string,
  relativePath: unknown,
  body: Uint8Array,
  label: string,
): void {
  if (typeof relativePath !== "string" || !isRepositoryPath(relativePath)) {
    throw new Error(`${label} lacks a normalized builder path`);
  }
  const path = join(inputRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, body, { flag: "wx", mode: 0o600 });
}

async function runCanonicalEvidence(
  request: PagesEvidenceRequestV1,
  fixed: ProtectedAuthorities,
  handoff: PagesProductionHandoffV1,
  runtimeBundleBytes: Uint8Array,
  runtimeRoot: string,
  sourceRoot: string,
  staging: string,
  localLazyBodies: ReadonlyMap<string, LocalLazyBody>,
): Promise<JsonObject> {
  const definition = fixed.definitions.value.definitions.find(
    (value: JsonObject) => value.id === request.definition_id,
  );
  if (definition === undefined) throw new Error(`${request.definition_id} is not protected`);
  const runtime = runtimeIdentityFromBundle(runtimeBundleBytes);
  const vfsSha256 = sha256(request.vfs);
  const reportSha256 = sha256(canonicalJsonBytes(request.builder_report));
  const candidateProduct = {
    builder_report_sha256: reportSha256,
    manifest_digest: `sha256:${vfsSha256}`,
    vfs_layer_bytes: request.vfs.byteLength,
    vfs_layer_sha256: vfsSha256,
  };
  const contextBase = {
    boot: request.product.manifest.boot,
    candidate_product: candidateProduct,
    definition,
    host: request.host,
    mounts: request.product.manifest.mounts,
    product: { id: request.product.id, manifest_sha256: request.product.manifest_sha256 },
    request_digest: sha256(canonicalJsonBytes({
      builder_report_sha256: reportSha256,
      definition_sha256: request.definition_sha256,
      host: request.host,
      product_id: request.product.id,
      runtime_bundle_sha256: request.runtime_bundle_sha256,
      vfs_sha256: vfsSha256,
    })),
    run: {
      attempt: handoff.run.attempt,
      job_id: `${request.host}-pages-evidence-${request.definition_id}`,
      repository: handoff.run.repository,
      run_id: handoff.run.run_id,
      workflow_ref: handoff.run.workflow_ref,
    },
    runtime,
    schema: 1 as const,
  };
  const locator: CandidateProductLocatorV1 = {
    builder_report_sha256: reportSha256,
    immutable_reference:
      `https://automattic.github.io/kandelo/products/${request.product.id}/` +
      `sha256-${vfsSha256}/${request.product.id}-${handoff.target_abi.version}.vfs.zst` +
      `?sha256=${vfsSha256}&bytes=${request.vfs.byteLength}`,
    manifest_digest: `sha256:${vfsSha256}`,
    product_id: request.product.id,
    reference_class: "canonical",
    repository: `https://automattic.github.io/kandelo/products/${request.product.id}`,
    vfs_layer_bytes: request.vfs.byteLength,
    vfs_layer_sha256: vfsSha256,
  };
  const root = join(staging, "evidence", request.product.id, request.host, request.definition_id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const expectedLazyIds = definition.probe?.lazy_inputs === undefined
    ? []
    : array(definition.probe.lazy_inputs, `${request.definition_id} lazy input policy`)
      .map((value, index) => stableId(value, `${request.definition_id} lazy input ${index}`));
  if (!jsonEqual(expectedLazyIds, [...new Set(expectedLazyIds)].sort(ordinal))) {
    throw new Error(`${request.definition_id} lazy input policy is not sorted and unique`);
  }
  const resolvedById = new Map(
    request.resolved_inputs.inputs.map((input: JsonObject) => [input.id, input]),
  );
  const selectedLazyBodies = new Map<string, LocalLazyBody>();
  const protectedLazyInputs = expectedLazyIds.map((id) => {
    const input = resolvedById.get(id);
    const reference = text(input?.reference, `${id} canonical lazy reference`);
    const exact = localLazyBodies.get(reference);
    if (
      input?.effective_materialization !== "lazy-reference" || exact === undefined ||
      input.bytes !== exact.bytes || input.sha256 !== exact.sha256 ||
      exact.body.byteLength !== exact.bytes || sha256(exact.body) !== exact.sha256
    ) throw new Error(`${id} lacks one exact local canonical lazy body`);
    selectedLazyBodies.set(reference, exact);
    return {
      bytes: exact.bytes,
      id,
      path: writeBytes(join(root, "lazy", id), exact.body),
      reference,
      sha256: exact.sha256,
    };
  });
  const paths = {
    builderReport: writeCanonical(join(root, "builder-report.json"), request.builder_report),
    candidateLocator: writeCanonical(join(root, "locator.json"), locator),
    context: writeCanonical(join(root, "context.json"), {
      ...contextBase,
      kind: request.host === "node"
        ? "kandelo-vfs-product-node-evidence-context"
        : "kandelo-vfs-product-browser-evidence-context",
    }),
    output: join(root, "receipt.json"),
    resolvedInputs: writeCanonical(join(root, "resolved-inputs.json"), request.resolved_inputs),
    lazyInputs: writeCanonical(join(root, "lazy-inputs.json"), {
      inputs: protectedLazyInputs,
      kind: "kandelo-protected-node-lazy-inputs",
      schema: 1,
    }),
    vfs: writeBytes(join(root, request.product.output), request.vfs),
  };
  if (request.host === "node") {
    const options: NodeEvidenceCliOptions = {
      builderReport: paths.builderReport,
      candidateLocator: paths.candidateLocator,
      context: paths.context,
      definitions: join(sourceRoot, fixed.definitions.path),
      output: paths.output,
      products: join(sourceRoot, fixed.catalog.path),
      resolvedInputs: paths.resolvedInputs,
      runtimeBundle: handoff.runtime_bundle,
      runtimeRoot,
      lazyInputs: paths.lazyInputs,
      ...(definition.runner === "compile" ? { sourceRoot } : {}),
      vfs: paths.vfs,
    };
    return superviseNodeEvidenceCli(options);
  }
  const options: BrowserEvidenceCliOptions = {
    builderReport: paths.builderReport,
    candidateLocator: paths.candidateLocator,
    context: paths.context,
    definitions: join(sourceRoot, fixed.definitions.path),
    output: paths.output,
    pages: join(sourceRoot, fixed.pages.path),
    products: join(sourceRoot, fixed.catalog.path),
    resolvedInputs: paths.resolvedInputs,
    runtimeBundle: handoff.runtime_bundle,
    runtimeRoot,
    tests: join(sourceRoot, fixed.tests.path),
    vfs: paths.vfs,
  };
  return superviseBrowserEvidenceCli(options, {
    server: { createLazyFetcher: createLocalLazyFetcher(selectedLazyBodies) },
  });
}

function writeReadyArtifacts(
  staging: string,
  artifacts: NonNullable<Awaited<ReturnType<typeof computePagesReadiness>>["artifacts"]>,
): void {
  for (const artifact of artifacts) {
    const root = join(staging, "artifacts", "products", artifact.id);
    writeCanonical(join(root, "resolved-inputs.json"), artifact.resolved_inputs);
    writeCanonical(join(root, "builder-report.json"), artifact.builder_report);
    writeBytes(join(root, `${artifact.id}.vfs.zst`), artifact.vfs);
    for (const [host, receipts] of [
      ["node", artifact.node_receipts],
      ["browser", artifact.browser_receipts],
    ] as const) {
      for (const receipt of receipts) {
        writeCanonical(join(root, host, `${receipt.definition.id}.json`), receipt);
      }
    }
  }
}

function assembleSourceTree(
  staging: string,
  siteSourceRoot: string,
  siteManifest: NonNullable<Awaited<ReturnType<typeof computePagesReadiness>>["site_manifest"]>,
  artifacts: NonNullable<Awaited<ReturnType<typeof computePagesReadiness>>["artifacts"]>,
  inputBodies: Map<string, { body: Uint8Array; identity: PagesFileIdentityV1 }>,
): void {
  const destination = join(staging, "source-tree");
  if (resolve(siteSourceRoot) !== resolve(destination)) {
    cpSync(siteSourceRoot, destination, {
      dereference: false,
      errorOnExist: true,
      filter(path) {
        if (lstatSync(path).isSymbolicLink()) {
          throw new Error("Pages site source contains a symbolic link");
        }
        return true;
      },
      force: false,
      recursive: true,
    });
  } else {
    exactDirectory(destination, "final built Pages site source root");
  }
  for (const { body, identity } of inputBodies.values()) {
    writeSiteFile(destination, identity, body);
  }
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const product of siteManifest.products) {
    const artifact = byId.get(product.id);
    if (artifact === undefined) throw new Error(`site product ${product.id} lacks final VFS bytes`);
    writeSiteFile(destination, {
      bytes: product.vfs_bytes,
      path: product.path,
      sha256: product.vfs_sha256,
    }, artifact.vfs);
  }
  const manifestBytes = canonicalJsonBytes(siteManifest);
  writeSiteFile(destination, {
    bytes: manifestBytes.byteLength,
    path: ".well-known/kandelo/pages-deployment.json",
    sha256: sha256(manifestBytes),
  }, manifestBytes);
  const inventory = inventoryTree(destination, MAX_SITE_BYTES);
  const deploymentPath = ".well-known/kandelo/pages-deployment.json";
  const expected = [
    ...siteManifest.files,
    { bytes: manifestBytes.byteLength, path: deploymentPath, sha256: sha256(manifestBytes) },
  ].sort((left, right) => ordinal(left.path, right.path));
  if (!jsonEqual(inventory, expected)) {
    throw new Error("assembled Pages source tree differs from its exact site manifest");
  }
}

function writeSiteFile(root: string, identity: PagesFileIdentityV1, body: Uint8Array): void {
  if (!isRepositoryPath(identity.path)) throw new Error("Pages site file path is invalid");
  if (body.byteLength !== identity.bytes || sha256(body) !== identity.sha256) {
    throw new Error(`Pages site file ${identity.path} differs from its identity`);
  }
  const path = join(root, identity.path);
  if (existsSync(path)) {
    const existing = readBoundedFile(path, `existing Pages file ${identity.path}`, MAX_VFS_BYTES);
    if (!bytesEqual(existing, body)) throw new Error(`Pages site path ${identity.path} conflicts`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, body, { flag: "wx", mode: 0o644 });
}

function writeCanonical(path: string, value: unknown): string {
  return writeBytes(path, canonicalJsonBytes(value));
}

function writeBytes(path: string, value: Uint8Array): string {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
  return path;
}

async function validateAdmissionRecord(
  bytes: Uint8Array,
  sourceRoot: string,
  staging: string,
): Promise<void> {
  const root = join(staging, "admission-validation");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(root, ".record-"));
  try {
    const path = writeBytes(join(temporary, "record.json"), bytes);
    runCommand("cargo", [
      "run", "-p", "xtask", "--quiet", "--", "abi-staging", "records",
      "validate", "--record", path,
    ], sourceRoot, 16 * 1024 * 1024);
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

async function observeAdmissionProjection(
  bytes: Uint8Array,
  tapRoot: string,
  expectedTapSource: PagesProductionHandoffV1["tap_source"],
  staging: string,
): Promise<JsonObject> {
  const root = join(staging, "admission-projections");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(root, ".projection-"));
  try {
    const recordPath = writeBytes(join(temporary, "record.json"), bytes);
    const outputPath = join(temporary, "observation.json");
    runCommand("python3", [
      "-B", "-m", "scripts.abi_staging.cli", "validate-admission-projection",
      "--tap-root", tapRoot,
      "--record", recordPath,
      "--out", outputPath,
    ], tapRoot, 16 * 1024 * 1024);
    const observation = readCanonicalFile(
      outputPath,
      "current admission projection",
      MAX_DOCUMENT_BYTES,
    );
    if (!jsonEqual(observation.tap_source, expectedTapSource)) {
      throw new Error("current admission projection names another tap-main source");
    }
    return observation;
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

function validateProtectedRegistries(sourceRoot: string): void {
  const rustc = spawnSync("rustc", ["-vV"], {
    cwd: sourceRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: MAX_DOCUMENT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (rustc.error !== undefined) throw rustc.error;
  if (rustc.status !== 0 || rustc.signal !== null) {
    throw new Error(`rustc -vV failed: ${String(rustc.stderr).slice(0, 4096)}`);
  }
  const hostTarget = String(rustc.stdout).match(/^host: (\S+)$/mu)?.[1];
  if (hostTarget === undefined) throw new Error("rustc did not report its exact host target");
  runCommand("cargo", [
    "run", "-p", "xtask", "--target", hostTarget, "--quiet", "--",
    "abi-staging", "registries", "check",
    "--catalog", "images/vfs/products/generated/catalog.json",
    "--pages", "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
    "--pages-generated",
    "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
    "--tests", "tests/vfs-products.toml",
    "--tests-generated", "tests/vfs-products.generated.json",
  ], sourceRoot, 16 * 1024 * 1024);
}

function createAnonymousOciAuthority(): ProductionOciAuthority {
  const fetchManifest = async (reference: string) => runOras([
    "manifest", "fetch", "--output", "-", reference,
  ], MAX_DOCUMENT_BYTES, "OCI manifest");
  const fetchBlob = async (repository: string, digestValue: string, bytes: number) => {
    if (
      !Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_LAZY_INPUT_BYTES ||
      !/^sha256:[0-9a-f]{64}$/u.test(digestValue)
    ) throw new Error("OCI blob descriptor is outside its bound");
    return runOras([
      "blob", "fetch", "--output", "-", `${repository}@${digestValue}`,
    ], bytes, "OCI blob", bytes);
  };
  return {
    fetchBlob,
    fetchManifest,
    async listImmutableReferences(repository) {
      let output: Uint8Array;
      try {
        output = await runOras([
          "repo", "tags", "--format", "json", repository,
        ], MAX_DOCUMENT_BYTES, "OCI tag inventory");
      } catch (error) {
        // GHCR reports an as-yet-uncreated public nested package as `denied`,
        // not as an empty tag inventory. For an exact Pages record repository,
        // anonymous inaccessibility means there is no publicly consumable
        // candidate or admission. Preserve that as the normal hold-only state;
        // manifest and blob reads remain exact and fail closed.
        if (isAbsentPublicPagesRecordTagInventory(repository, error)) return [];
        throw error;
      }
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
      const tags = array(record(value, "OCI tag inventory").tags, "OCI tags");
      if (tags.length > MAX_OCI_TAGS) throw new Error("OCI tag inventory exceeds its bound");
      return immutableRecordReferencesFromTags(repository, tags);
    },
    async readAdmissionRecord(reference) {
      const { repository, digest: manifestDigest } = immutableOciReference(
        reference,
        "admission reference",
      );
      const manifestBytes = await fetchManifest(reference);
      if (sha256(manifestBytes) !== manifestDigest) {
        throw new Error("admission manifest differs from its immutable reference");
      }
      const manifest = canonicalDocument(manifestBytes, "admission manifest");
      if (
        manifest.schemaVersion !== 2 || manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE ||
        manifest.artifactType !== "application/vnd.kandelo.homebrew.admission.v1+json"
      ) throw new Error("admission manifest has unsupported identity");
      const config = descriptor(
        manifest.config,
        "admission-record",
        "application/vnd.kandelo.homebrew.admission.v1+json",
        "admission-record.json",
        "admission config",
        MAX_DOCUMENT_BYTES,
      );
      const layers = array(manifest.layers, "admission layers");
      if (layers.length !== 1) throw new Error("admission manifest layer count differs");
      const layer = descriptor(
        layers[0],
        "immutable-record-bytes",
        "application/vnd.kandelo.homebrew.admission.v1+json",
        "admission-record.json",
        "admission record layer",
        MAX_DOCUMENT_BYTES,
      );
      const configBytes = await exactBlob({ fetchManifest, fetchBlob }, repository, config);
      const layerBytes = await exactBlob({ fetchManifest, fetchBlob }, repository, layer);
      if (!bytesEqual(configBytes, layerBytes)) {
        throw new Error("admission config and immutable record bytes differ");
      }
      return canonicalDocument(configBytes, "admission record");
    },
    async fetchCanonicalOci(reference) {
      const { repository, digest: manifestDigest } = immutableOciReference(
        reference,
        "canonical bottle reference",
      );
      const manifest = await fetchManifest(reference);
      if (sha256(manifest) !== manifestDigest) {
        throw new Error("canonical bottle manifest differs from its immutable reference");
      }
      const value = canonicalDocument(manifest, "canonical bottle manifest");
      const config = descriptorShape(value.config, "canonical bottle config");
      const layers = array(value.layers, "canonical bottle layers")
        .map((item, index) => descriptorShape(item, `canonical bottle layer ${index}`));
      if (layers.length !== 3) throw new Error("canonical bottle layer count differs");
      const [bottle, metadata, composition] = layers;
      if (
        config.bytes > MAX_DOCUMENT_BYTES || bottle!.bytes > MAX_LAZY_INPUT_BYTES ||
        metadata!.bytes > MAX_DOCUMENT_BYTES || composition!.bytes > MAX_DOCUMENT_BYTES
      ) throw new Error("canonical bottle descriptor exceeds its byte bound");
      return {
        bottle_layer: await exactBlob({ fetchManifest, fetchBlob }, repository, bottle!),
        bottle_metadata: await exactBlob({ fetchManifest, fetchBlob }, repository, metadata!),
        config: await exactBlob({ fetchManifest, fetchBlob }, repository, config),
        manifest,
        vfs_composition_descriptor: await exactBlob(
          { fetchManifest, fetchBlob }, repository, composition!,
        ),
      };
    },
  };
}

export function isAbsentPublicPagesRecordTagInventory(
  repository: string,
  error: unknown,
): boolean {
  return (
    (
      /^ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[1-9][0-9]*\/[a-z0-9._-]+\/admissions$/u
        .test(repository) ||
      /^ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[1-9][0-9]*-candidates\/products\/[a-z0-9._-]+$/u
        .test(repository)
    ) &&
    error instanceof Error &&
    /^OCI tag inventory anonymous read failed: Error response from registry: denied: requested access to the resource is denied\s*$/u
      .test(error.message)
  );
}

export function immutableRecordReferencesFromTags(
  repository: string,
  tags: readonly unknown[],
): string[] {
  if (
    typeof repository !== "string" || repository.length > 4_096 ||
    !/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._/-]+$/u.test(repository)
  ) throw new Error("immutable OCI record repository is invalid");
  if (!Array.isArray(tags) || tags.length > MAX_OCI_TAGS) {
    throw new Error("OCI tag inventory exceeds its bound");
  }
  return tags.flatMap((value, index) => {
    const tag = text(value, `OCI tag ${index}`);
    const match = tag.match(/^record-sha256-([0-9a-f]{64})$/u);
    return match === null ? [] : [`${repository}@sha256:${match[1]}`];
  }).sort(ordinal);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  const normalize = (candidate: unknown): unknown => {
    if (
      candidate === null || typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) return candidate;
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate)) {
        throw new Error("canonical JSON permits safe integer numbers only");
      }
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (typeof candidate !== "object") {
      throw new Error("canonical JSON contains an unsupported value");
    }
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => ordinal(left, right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  };
  return new TextEncoder().encode(`${JSON.stringify(normalize(value))}\n`);
}

export async function readCandidateProductAuthority(
  immutableReference: string,
  expected: {
    productId: string;
    source: { repository: string; commit: string; tree: string };
    targetAbi: { version: number; snapshot_sha256: string };
    permitOtherSourceTree?: boolean;
  },
  readback: CandidateProductReadback,
): Promise<CandidateProductAuthorityV1> {
  stableId(expected.productId, "candidate product ID");
  const reference = validateCandidateProductReference(
    immutableReference,
    expected.productId,
    expected.targetAbi.version,
  );
  const repository = reference.repository;
  const manifestBytes = await readback.fetchManifest(immutableReference);
  if (sha256(manifestBytes) !== reference.digest) {
    throw new Error("candidate product manifest differs from its immutable reference");
  }
  const manifest = canonicalDocument(manifestBytes, "candidate product manifest");
  exactKeys(
    manifest,
    ["annotations", "artifactType", "config", "layers", "mediaType", "schemaVersion"],
    "candidate product manifest",
  );
  if (
    manifest.schemaVersion !== 2 || manifest.mediaType !== OCI_MANIFEST_MEDIA_TYPE ||
    manifest.artifactType !== CANDIDATE_ARTIFACT_TYPE
  ) throw new Error("candidate product manifest has unsupported identity");
  const expectedAnnotations = {
    "dev.kandelo.abi-staging.architecture": undefined as unknown,
    "dev.kandelo.abi-staging.classification": "public-candidate-not-endorsed",
    "dev.kandelo.abi-staging.kind": "candidate-product",
    "dev.kandelo.abi-staging.nonendorsed": "true",
    "dev.kandelo.abi-staging.product": expected.productId,
    "dev.kandelo.abi-staging.target-abi": String(expected.targetAbi.version),
    "org.opencontainers.image.source": `https://github.com/${expected.source.repository}`,
  };
  const annotations = record(manifest.annotations, "candidate product annotations");
  exactKeys(annotations, Object.keys(expectedAnnotations), "candidate product annotations");
  for (const [key, value] of Object.entries(expectedAnnotations)) {
    if (value !== undefined && annotations[key] !== value) {
      throw new Error("candidate product manifest annotations differ from protected authority");
    }
  }

  const configDescriptor = descriptor(
    manifest.config,
    "candidate-product-record",
    CANDIDATE_ARTIFACT_TYPE,
    "candidate-product-record.json",
    "candidate product config",
    MAX_DOCUMENT_BYTES,
  );
  const configBytes = await exactBlob(readback, repository, configDescriptor);
  const candidateRecord = canonicalDocument(configBytes, "candidate product record");
  exactKeys(candidateRecord, [
    "artifacts", "kind", "nonendorsed", "product", "reference_class", "schema",
    "source", "target_abi",
  ], "candidate product record");
  if (
    candidateRecord.schema !== 1 ||
    candidateRecord.kind !== "kandelo-vfs-candidate-product" ||
    candidateRecord.reference_class !== "candidate" || candidateRecord.nonendorsed !== true ||
    candidateRecord.source?.repository !== expected.source.repository ||
    !/^[0-9a-f]{40}$/u.test(candidateRecord.source?.commit) ||
    !/^[0-9a-f]{40}$/u.test(candidateRecord.source?.tree) ||
    (!expected.permitOtherSourceTree && candidateRecord.source.tree !== expected.source.tree) ||
    !jsonEqual(candidateRecord.target_abi, expected.targetAbi) ||
    candidateRecord.product?.id !== expected.productId ||
    annotations["dev.kandelo.abi-staging.architecture"] !==
      candidateRecord.product?.architecture
  ) throw new Error("candidate product record differs from protected authority");

  const artifacts = record(candidateRecord.artifacts, "candidate product artifacts");
  exactKeys(artifacts, [
    "builder_report", "lazy_inputs", "resolved_inputs", "runtime_bundle", "vfs_image",
  ], "candidate product artifacts");
  const layers = array(manifest.layers, "candidate product layers").map(
    (value, index) => descriptorShape(value, `candidate product layer ${index}`),
  );
  const lazyArtifacts = array(artifacts.lazy_inputs, "candidate product lazy inputs");
  if (layers.length !== 4 + lazyArtifacts.length) {
    throw new Error("candidate product OCI layer count differs from its record");
  }
  const fixed = [
    ["vfs_image", "vfs-image", VFS_IMAGE_MEDIA_TYPE, candidateRecord.product.output],
    ["builder_report", "builder-report", BUILDER_REPORT_MEDIA_TYPE, "builder-report.json"],
    ["resolved_inputs", "resolved-inputs", RESOLVED_INPUTS_MEDIA_TYPE, "resolved-inputs.json"],
    ["runtime_bundle", "runtime-bundle", RUNTIME_BUNDLE_MEDIA_TYPE, "runtime-bundle.json"],
  ] as const;
  for (let index = 0; index < fixed.length; index++) {
    const [key, role, mediaType, title] = fixed[index]!;
    const expectedArtifact = artifactIdentity(artifacts[key], repository, key);
    requireDescriptor(layers[index]!, role, mediaType, title, expectedArtifact, key);
  }

  if (lazyArtifacts.length > MAX_LAZY_INPUTS) {
    throw new Error("candidate product lazy input count exceeds its bound");
  }
  const lazyInputs = new Map<string, { bytes: number; sha256: string }>();
  let previous = "";
  let lazyBytes = 0;
  for (let index = 0; index < lazyArtifacts.length; index++) {
    const lazy = record(lazyArtifacts[index], `candidate product lazy input ${index}`);
    exactKeys(lazy, ["bytes", "id", "immutable_reference", "kind", "sha256"],
      `candidate product lazy input ${index}`);
    const id = stableId(lazy.id, `candidate product lazy input ${index} ID`);
    if (id <= previous) throw new Error("candidate product lazy inputs are not sorted and unique");
    previous = id;
    if (![
      "package-output", "repository-path", "source-archive", "toolchain-output",
    ].includes(lazy.kind)) throw new Error("candidate product lazy input kind is unsupported");
    const identity = artifactIdentity(lazy, repository, `lazy input ${id}`);
    if (identity.bytes > MAX_LAZY_INPUT_BYTES) {
      throw new Error(`candidate product lazy input ${id} exceeds its byte bound`);
    }
    lazyBytes += identity.bytes;
    if (
      !Number.isSafeInteger(lazyBytes) ||
      lazyBytes > MAX_LAZY_INPUT_AGGREGATE_BYTES
    ) throw new Error("candidate product lazy inputs exceed their aggregate byte bound");
    const selected = layers[index + 4]!;
    requireDescriptor(
      selected,
      `lazy-input-${String(index).padStart(4, "0")}`,
      LAZY_INPUT_MEDIA_TYPE,
      `lazy-input-${id}`,
      identity,
      `lazy input ${id}`,
    );
    lazyInputs.set(id, { bytes: identity.bytes, sha256: identity.sha256 });
  }

  // The VFS layer at index zero is intentionally authenticated by descriptor
  // but never fetched: final Pages bytes must be rebuilt from current inputs.
  const builderReportBytes = await exactBlob(readback, repository, layers[1]!);
  const resolvedInputsBytes = await exactBlob(readback, repository, layers[2]!);
  const runtimeBundleBytes = await exactBlob(readback, repository, layers[3]!);
  const builderReport = canonicalDocument(builderReportBytes, "candidate builder report");
  const resolvedInputs = canonicalDocument(resolvedInputsBytes, "candidate resolved inputs");
  const runtimeBundle = canonicalDocument(runtimeBundleBytes, "candidate runtime bundle");
  validateCandidateDocuments(
    candidateRecord,
    resolvedInputs,
    resolvedInputsBytes,
    builderReport,
    layers[0]!,
  );
  return {
    builderReport,
    candidateRecord,
    lazyInputs,
    resolvedInputs,
    runtimeBundle,
    runtimeBundleBytes,
  };
}

export function rebuildCurrentResolvedInputs(
  candidateResolved: JsonObject,
  inventory: JsonObject,
): JsonObject {
  const candidateProduct = record(candidateResolved.product, "candidate product identity");
  const { output: _output, ...collectableProduct } = candidateProduct;
  if (
    inventory.schema !== 1 ||
    inventory.kind !== "kandelo-vfs-product-input-object-inventory" ||
    !jsonEqual(inventory.product, collectableProduct) ||
    !jsonEqual(inventory.target_abi, candidateResolved.target_abi) ||
    !jsonEqual(inventory.build_environment, candidateResolved.build_environment)
  ) throw new Error("current-main input inventory differs from candidate product identity");
  if (
    inventory.source?.repository !== candidateResolved.source?.repository ||
    inventory.source?.tree !== candidateResolved.source?.tree
  ) throw new Error("current-main source tree differs from the candidate-proven source tree");
  const objects = array(inventory.objects, "current-main input objects");
  const byId = new Map(objects.map((value, index) => {
    const object = record(value, `current-main input object ${index}`);
    return [stableId(object.id, `current-main input object ${index} ID`), object] as const;
  }));
  if (byId.size !== objects.length) {
    throw new Error("complete current-main input inventory contains duplicate IDs");
  }
  const consumed = new Set<string>();
  const inputs = array(candidateResolved.inputs, "candidate resolved inputs").map(
    (value, index) => {
      const input = record(value, `candidate resolved input ${index}`);
      if (input.kind === "homebrew-bottle" || input.kind === "product-image") {
        return structuredClone(input);
      }
      const id = stableId(input.id, `candidate resolved input ${index} ID`);
      const object = byId.get(id);
      if (object === undefined || consumed.has(id)) {
        throw new Error("candidate differs from the complete current-main input inventory");
      }
      consumed.add(id);
      const semanticKeys = [
        "architecture", "declared_materialization", "kind", "role",
        "package", "selector_kind", "selector", "archive_id", "url",
        "toolchain_id", "provider", "component", "repository_id", "paths",
      ];
      const identityKeys = input.kind === "repository-path"
        ? semanticKeys
        : [...semanticKeys, "bytes", "sha256"];
      for (const key of identityKeys) {
        if (
          !(input[key] === undefined && object[key] === undefined) &&
          !jsonEqual(input[key], object[key])
        ) {
          throw new Error(`current-main input ${id} differs from candidate-proven identity`);
        }
      }
      return {
        ...structuredClone(input),
        bytes: object.bytes,
        reference: undefined,
        sha256: object.sha256,
        ...(input.effective_materialization === "lazy-reference"
          ? { path: undefined }
          : { path: object.path }),
      };
    },
  );
  if (consumed.size !== byId.size) {
    throw new Error("candidate differs from the complete current-main input inventory");
  }
  return {
    ...structuredClone(candidateResolved),
    inputs,
    source: structuredClone(inventory.source),
  };
}

function validateCandidateDocuments(
  candidateRecord: JsonObject,
  resolved: JsonObject,
  resolvedBytes: Uint8Array,
  report: JsonObject,
  vfsDescriptor: OciDescriptor,
): void {
  if (
    resolved.schema !== 1 || resolved.kind !== "kandelo-resolved-vfs-product-inputs" ||
    resolved.reference_class !== "candidate" ||
    !jsonEqual(resolved.product, candidateRecord.product) ||
    !jsonEqual(resolved.source, candidateRecord.source) ||
    !jsonEqual(resolved.target_abi, candidateRecord.target_abi)
  ) throw new Error("candidate resolved inputs differ from candidate product record");
  const expectedInputs = array(resolved.inputs, "candidate resolved inputs").map((value) => {
    const input = record(value, "candidate resolved input");
    return {
      bytes: input.bytes,
      ...(input.descriptor === undefined
        ? {}
        : { descriptor: {
          bytes: input.descriptor.bytes,
          sha256: input.descriptor.sha256,
        } }),
      id: input.id,
      kind: input.kind,
      placement: input.effective_materialization,
      role: input.role,
      sha256: input.sha256,
    };
  });
  if (
    report.schema !== 1 || report.kind !== "kandelo-vfs-builder-report" ||
    report.capture?.complete !== true || !jsonEqual(report.capture?.unreported_reads, []) ||
    report.resolved_inputs_sha256 !== sha256(resolvedBytes) ||
    !jsonEqual(report.product, resolved.product) || !jsonEqual(report.inputs, expectedInputs) ||
    report.output?.sha256 !== vfsDescriptor.digest.slice(7) ||
    report.output?.bytes !== vfsDescriptor.bytes ||
    report.output?.name !== resolved.product.output ||
    report.output?.path !== resolved.product.output
  ) throw new Error("candidate builder report differs from exact resolved inputs");
}

interface OciDescriptor {
  bytes: number;
  digest: string;
  mediaType: string;
  role: string;
  title: string;
}

function descriptor(
  value: unknown,
  role: string,
  mediaType: string,
  title: string,
  label: string,
  maximumBytes: number,
): OciDescriptor {
  const selected = descriptorShape(value, label);
  if (selected.bytes > maximumBytes) throw new Error(`${label} exceeds its byte bound`);
  if (selected.role !== role || selected.mediaType !== mediaType || selected.title !== title) {
    throw new Error(`${label} descriptor metadata changed`);
  }
  return selected;
}

function descriptorShape(value: unknown, label: string): OciDescriptor {
  const item = record(value, label);
  exactKeys(item, ["annotations", "digest", "mediaType", "size"], label);
  const annotations = record(item.annotations, `${label} annotations`);
  exactKeys(annotations, [
    "dev.kandelo.abi-staging.role", "org.opencontainers.image.title",
  ], `${label} annotations`);
  const digest = text(item.digest, `${label} digest`);
  if (!digest.startsWith("sha256:") || !SHA256.test(digest.slice(7))) {
    throw new Error(`${label} digest is invalid`);
  }
  const bytes = positiveInteger(item.size, `${label} bytes`);
  return {
    bytes,
    digest,
    mediaType: text(item.mediaType, `${label} media type`),
    role: text(annotations["dev.kandelo.abi-staging.role"], `${label} role`),
    title: text(annotations["org.opencontainers.image.title"], `${label} title`),
  };
}

function requireDescriptor(
  descriptor: OciDescriptor,
  role: string,
  mediaType: string,
  title: string,
  artifact: { bytes: number; sha256: string },
  label: string,
): void {
  const maximumBytes = role === "vfs-image"
    ? MAX_VFS_BYTES
    : role === "runtime-bundle"
    ? MAX_RUNTIME_BUNDLE_BYTES
    : role.startsWith("lazy-input-")
    ? MAX_LAZY_INPUT_BYTES
    : MAX_DOCUMENT_BYTES;
  if (descriptor.bytes > maximumBytes) {
    throw new Error(`${label} descriptor exceeds its byte bound`);
  }
  if (
    descriptor.role !== role || descriptor.mediaType !== mediaType ||
    descriptor.title !== title || descriptor.digest !== `sha256:${artifact.sha256}` ||
    descriptor.bytes !== artifact.bytes
  ) throw new Error(`${label} OCI descriptor differs from its candidate record`);
}

async function exactBlob(
  readback: CandidateProductReadback,
  repository: string,
  descriptor: OciDescriptor,
): Promise<Uint8Array> {
  const body = await readback.fetchBlob(repository, descriptor.digest, descriptor.bytes);
  if (body.byteLength !== descriptor.bytes || sha256(body) !== descriptor.digest.slice(7)) {
    throw new Error(`${descriptor.role} blob differs from its exact OCI descriptor`);
  }
  return new Uint8Array(body);
}

function artifactIdentity(
  value: unknown,
  repository: string,
  label: string,
): { bytes: number; sha256: string } {
  const artifact = record(value, `candidate product ${label}`);
  const sha = digest(artifact.sha256, `candidate product ${label} digest`);
  const bytes = positiveInteger(artifact.bytes, `candidate product ${label} bytes`);
  if (artifact.immutable_reference !== `${repository}@sha256:${sha}`) {
    throw new Error(`candidate product ${label} reference differs from its repository`);
  }
  return { bytes, sha256: sha };
}

export function validateCandidateProductReference(
  reference: string,
  productId: string,
  abi: number,
) {
  stableId(productId, "candidate product ID");
  const repository =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${abi}-candidates/products/${productId}`;
  const prefix = `${repository}@sha256:`;
  const digestValue = reference.startsWith(prefix) ? reference.slice(prefix.length) : "";
  if (!SHA256.test(digestValue) || reference !== `${prefix}${digestValue}`) {
    throw new Error("candidate product reference leaves its exact ABI namespace");
  }
  return { repository, digest: digestValue };
}

function canonicalDocument(bytes: Uint8Array, label: string): JsonObject {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_RUNTIME_BUNDLE_BYTES) {
    throw new Error(`${label} is empty or exceeds its byte bound`);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(`${label} is invalid JSON`, { cause: error });
  }
  if (!bytesEqual(bytes, canonicalJsonBytes(value))) throw new Error(`${label} is not canonical JSON`);
  return record(value, label);
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  if (!jsonEqual(Object.keys(value).sort(ordinal), [...expected].sort(ordinal))) {
    throw new Error(`${label} fields differ`);
  }
}

function record(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableId(value: unknown, label: string): string {
  const selected = text(value, label);
  if (!STABLE_ID.test(selected)) throw new Error(`${label} is not a stable ID`);
  return selected;
}

function digest(value: unknown, label: string): string {
  const selected = text(value, label);
  if (!SHA256.test(selected)) throw new Error(`${label} is not a SHA-256 digest`);
  return selected;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} is not a positive safe integer`);
  }
  return Number(value);
}

function absolutePath(value: unknown, label: string): string {
  const path = text(value, label);
  if (!path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
    path.split("/").some((part) => part === "." || part === "..")) {
    throw new Error(`${label} is not a normalized absolute path`);
  }
  return path;
}

function exactDirectory(path: string, label: string): string {
  const absolute = absolutePath(path, label);
  const metadata = lstatSync(absolute);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} is not a real directory`);
  }
  return realpathSync.native(absolute);
}

function inventoryTree(root: string, maximumBytes: number): PagesFileIdentityV1[] {
  const files: PagesFileIdentityV1[] = [];
  let total = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 64) throw new Error("Pages site source exceeds its depth bound");
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => ordinal(left.name, right.name),
    )) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        throw new Error("Pages site source contains a symbolic link");
      }
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (
        !entry.isFile() || !metadata.isFile() || metadata.nlink !== 1 ||
        files.length >= MAX_SITE_FILES || metadata.size < 1 ||
        total + metadata.size > maximumBytes
      ) throw new Error("Pages site source exceeds its file or byte bound");
      const body = new Uint8Array(readFileSync(path));
      if (body.byteLength !== metadata.size) {
        throw new Error("Pages site source changed while it was inventoried");
      }
      total += body.byteLength;
      files.push({
        bytes: body.byteLength,
        path: relative(root, path).split(sep).join("/"),
        sha256: sha256(body),
      });
    }
  };
  visit(root, 0);
  return files.sort((left, right) => ordinal(left.path, right.path));
}

function readCanonicalFile(path: string, label: string, maximumBytes: number): JsonObject {
  return canonicalDocument(readBoundedFile(path, label, maximumBytes), label);
}

function readBoundedFile(
  path: string,
  label: string,
  maximumBytes: number,
  expectedBytes?: number,
): Uint8Array {
  const absolute = absolutePath(path, label);
  const metadata = lstatSync(absolute);
  if (
    metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 ||
    metadata.size < 1 || metadata.size > maximumBytes ||
    (expectedBytes !== undefined && metadata.size !== expectedBytes)
  ) throw new Error(`${label} is not one bounded regular file`);
  const body = new Uint8Array(readFileSync(absolute));
  if (body.byteLength !== metadata.size) throw new Error(`${label} changed while it was read`);
  return body;
}

function isRepositoryPath(value: string): boolean {
  return value.length > 0 && value.length <= 4_096 && !value.startsWith("/") &&
    !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function immutableOciReference(reference: string, label: string) {
  const match = reference.match(
    /^(ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[0-9]+\/[a-z0-9._/-]+)@sha256:([0-9a-f]{64})$/u,
  );
  if (match === null || reference.includes("-candidates/")) {
    throw new Error(`${label} is outside the canonical ABI namespace`);
  }
  return { digest: match[2]!, repository: match[1]! };
}

async function runOras(
  args: string[],
  maximumBytes: number,
  label: string,
  expectedBytes?: number,
): Promise<Uint8Array> {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-oras-"));
  try {
    const config = join(root, "registry-config.json");
    writeFileSync(config, "{}\n", { flag: "wx", mode: 0o600 });
    const protectedArgs = [
      ...args.slice(0, 2), "--registry-config", config, ...args.slice(2),
    ];
    const result = spawnSync("oras", protectedArgs, {
      cwd: root,
      encoding: null,
      env: safeToolEnvironment(root),
      input: new Uint8Array(),
      maxBuffer: maximumBytes + 1,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0 || result.signal !== null) {
      throw new Error(`${label} anonymous read failed: ${Buffer.from(result.stderr).toString("utf8").slice(0, 4096)}`);
    }
    const body = new Uint8Array(result.stdout);
    if (
      body.byteLength < 1 || body.byteLength > maximumBytes ||
      (expectedBytes !== undefined && body.byteLength !== expectedBytes)
    ) throw new Error(`${label} response differs from its byte bound`);
    return body;
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function safeToolEnvironment(temporaryHome: string): Record<string, string> {
  const environment: Record<string, string> = { HOME: temporaryHome };
  for (const name of [
    "LANG", "LC_ALL", "LC_CTYPE", "NIX_SSL_CERT_FILE", "NO_COLOR", "PATH",
    "SSL_CERT_FILE", "TERM", "TZ",
  ]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function assertUncredentialedEnvironment(environment: NodeJS.ProcessEnv): void {
  const forbidden = [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "AWS_ACCESS_KEY_ID", "GITHUB_TOKEN", "GH_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS", "KANDELO_STAGING_BOT_TOKEN", "NPM_TOKEN",
    "SSH_AUTH_SOCK",
  ].filter((name) => environment[name] !== undefined);
  if (forbidden.length > 0) {
    throw new Error(`Pages producer environment contains credentials: ${forbidden.join(", ")}`);
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  maximumBytes: number,
): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: maximumBytes,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${String(result.stderr).slice(0, 4096)}`,
    );
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return bytesEqual(canonicalJsonBytes(left), canonicalJsonBytes(right));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index]);
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function cli(args: readonly string[]): Promise<void> {
  if (
    args.length !== 5 || !["produce", "ship"].includes(args[0] ?? "") || args[1] !== "--input" ||
    args[3] !== "--output-root"
  ) {
    throw new Error(
      "usage: abi-staging-pages-producer.ts <produce|ship> --input <production-handoff.json> " +
      "--output-root <absent-output-directory>",
    );
  }
  if (args[0] === "ship") await shipPagesArtifacts(args[2]!, args[4]!);
  else await producePagesArtifacts(args[2]!, args[4]!);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void cli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
