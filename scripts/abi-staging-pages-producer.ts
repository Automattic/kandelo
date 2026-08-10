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
} from "./abi-staging-collect-product-inputs.ts";
import {
  canonicalPagesInputReference,
  canonicalPagesInputSitePath,
  computePagesReadiness,
  type AdmissionEnvelopeV1,
  type CanonicalProductBuildRequestV1,
  type CanonicalOciReadbackV1,
  type PagesEvidenceRequestV1,
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

export function createExactSourceReobserver(
  expected: ExactSourceObservation,
  verify: (value: ExactSourceObservation) => void = verifyExactProductSourceIdentity,
): () => void {
  verify(expected);
  return () => verify(expected);
}

export function heldPagesReadinessRecord(options: {
  blockers: Array<{ detail: string; kind: string; product_id: string }>;
  pagesRegistry: {
    path: string;
    products: Array<{ id: string; load: "eager" | "lazy" }>;
    sha256: string;
  };
  siteMetadataSha256: string;
  source: { repository: string; commit: string; tree: string };
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
    site_metadata_sha256: options.siteMetadataSha256,
    source: options.source,
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
    "site_source_root", "source", "source_root", "target_abi",
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
      return { gallery_entries: entries, id: stableId(entry.id, `Pages gallery product ${index} ID`) };
    });
  if (
    !jsonEqual(pageIds, [...new Set(pageIds)].sort(ordinal)) ||
    !jsonEqual(galleryProducts.map(({ id }) => id), pageIds)
  ) throw new Error("Pages gallery authority differs from the exact Pages product set");
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

export async function producePagesArtifacts(
  handoffPath: string,
  outputRoot: string,
  oci: ProductionOciAuthority = createAnonymousOciAuthority(),
): Promise<void> {
  assertUncredentialedEnvironment(process.env);
  const handoff = validatePagesProductionHandoff(
    readCanonicalFile(handoffPath, "Pages production handoff", MAX_DOCUMENT_BYTES),
  );
  const sourceRoot = exactDirectory(handoff.source_root, "exact current-main source root");
  const runtimeRoot = exactDirectory(handoff.runtime_root, "exact runtime artifact root");
  const siteSourceRoot = exactDirectory(handoff.site_source_root, "Pages site source root");
  const runtimeBundleBytes = readBoundedFile(
    handoff.runtime_bundle,
    "exact runtime bundle",
    MAX_RUNTIME_BUNDLE_BYTES,
  );
  const runtimeBundle = canonicalDocument(runtimeBundleBytes, "exact runtime bundle");
  const runtimeIdentity = runtimeIdentityFromBundle(runtimeBundleBytes);
  if (
    !jsonEqual(runtimeIdentity.source, handoff.source) ||
    !jsonEqual(runtimeIdentity.target_abi, handoff.target_abi)
  ) throw new Error("exact runtime bundle differs from the protected current-main handoff");
  validateExactRuntimeArtifactRoot(runtimeBundleBytes, runtimeRoot);
  const lockSha256 = exactRuntimeDevShellLockSha256(runtimeBundleBytes);
  const reobserveSource = createExactSourceReobserver({
    commit: handoff.source.commit,
    devShellLockSha256: lockSha256,
    root: sourceRoot,
    tree: handoff.source.tree,
  });

  const fixed = loadProtectedAuthorities(sourceRoot);
  const expectedProductIds = fixed.pages.value.products.map(({ id }: { id: string }) => id);
  if (!jsonEqual(handoff.products.map(({ id }) => id), expectedProductIds)) {
    throw new Error("production handoff products differ from the exact Pages registry");
  }
  const baseSiteMetadata = derivePagesSiteMetadata(
    siteSourceRoot,
    fixed.pages.value,
    fixed.gallery,
  );
  const output = absolutePath(outputRoot, "Pages producer output root");
  if (existsSync(output)) throw new Error("Pages producer output root already exists");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const staging = mkdtempSync(join(dirname(output), `.${output.split(sep).at(-1)}.staging-`));
  const productRoots = new Map<string, string>();
  const inputBodies = new Map<string, { body: Uint8Array; identity: PagesFileIdentityV1 }>();
  const localLazyBodies = new Map<string, LocalLazyBody>();
  try {
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
        const inventory = collectProductInputObjectsFromResolvedSources({
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
          input.kind === "homebrew-bottle" || input.kind === "product-image"
        ) continue;
        const object = inventory.objects.find(({ id }) => id === input.id);
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
          (recordBytes) => validateAdmissionRecord(recordBytes, sourceRoot, staging),
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
        siteMetadataSha256: readinessInput.authority.site_metadata_sha256,
        source: handoff.source,
        targetAbi: handoff.target_abi,
      });
      reobserveSource();
      writeAtomicHoldOnlyOutput(staging, output, heldReadiness);
      return;
    }
    const result = await computePagesReadiness(readinessInput, {
      buildProduct: (request) => buildCanonicalProduct(
        request,
        sourceRoot,
        productRoots.get(request.product.id)!,
        staging,
        localLazyBodies,
      ),
      fetchCanonicalOci: (reference) => oci.fetchCanonicalOci(reference),
      runEvidence: (request) => runCanonicalEvidence(
        request,
        fixed,
        handoff,
        runtimeBundleBytes,
        runtimeRoot,
        sourceRoot,
        staging,
        localLazyBodies,
      ),
      validateAdmissionRecord: (bytes) => validateAdmissionRecord(bytes, sourceRoot, staging),
    });
    writeCanonical(join(staging, "readiness.json"), result.readiness);
    if (!result.readiness.ready) {
      reobserveSource();
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
        siteSourceRoot,
        result.site_manifest,
        result.artifacts,
        inputBodies,
      );
    }
    reobserveSource();
    renameSync(staging, output);
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
}

type ProtectedAuthorities = ReturnType<typeof loadProtectedAuthorities>;

function loadProtectedAuthorities(sourceRoot: string) {
  const load = (repositoryPath: string, label: string) => {
    const path = join(sourceRoot, repositoryPath);
    const bytes = readBoundedFile(path, label, MAX_DOCUMENT_BYTES);
    return { path: repositoryPath, source_bytes: bytes, bytes, value: canonicalDocument(bytes, label) };
  };
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
    pages: load(
      "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
      "Pages product registry",
    ),
    tests: load("tests/vfs-products.generated.json", "test product registry"),
  };
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
    admissions.push(matching[0]!);
  }
  return admissions.sort((left, right) => ordinal(left.record_sha256, right.record_sha256));
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
      const output = await runOras([
        "repo", "tags", "--format", "json", repository,
      ], MAX_DOCUMENT_BYTES, "OCI tag inventory");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(output));
      const tags = array(record(value, "OCI tag inventory").tags, "OCI tags");
      if (tags.length > MAX_OCI_TAGS) throw new Error("OCI tag inventory exceeds its bound");
      return tags.flatMap((value, index) => {
        const tag = text(value, `OCI tag ${index}`);
        const match = tag.match(/^record-sha256-([0-9a-f]{64})$/u);
        return match === null ? [] : [`${repository}@sha256:${match[1]}`];
      }).sort(ordinal);
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
    args.length !== 5 || args[0] !== "produce" || args[1] !== "--input" ||
    args[3] !== "--output-root"
  ) {
    throw new Error(
      "usage: abi-staging-pages-producer.ts produce --input <production-handoff.json> " +
      "--output-root <absent-output-directory>",
    );
  }
  await producePagesArtifacts(args[2]!, args[4]!);
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
