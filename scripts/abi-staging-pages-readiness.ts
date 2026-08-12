import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { restoreVerifiedVfsImage } from "../host/src/vfs/load-image.ts";
import { validateProductEvidenceResult } from "./abi-staging-product-node-evidence.ts";
import { isVfsSpecifier } from "./check-pages-vfs-product-registry.mjs";

type JsonObject = Record<string, any>;
type PagesLoadV1 = "eager" | "lazy";
type EvidenceHostV1 = "node" | "browser";
const CANONICAL_PAGES_ORIGIN = "https://automattic.github.io/kandelo/";
const SHA256 = /^[0-9a-f]{64}$/u;
const STABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

export function canonicalPagesInputReference(
  inputId: string,
  sha256Value: string,
  bytes: number,
): string {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(inputId) ||
    !/^[0-9a-f]{64}$/u.test(sha256Value) ||
    !Number.isSafeInteger(bytes) || bytes <= 0
  ) {
    throw new Error("canonical Pages input identity is invalid");
  }
  return `${CANONICAL_PAGES_ORIGIN}${canonicalPagesInputSitePath(inputId, sha256Value)}` +
    `?sha256=${sha256Value}&bytes=${bytes}`;
}

export function canonicalPagesInputSitePath(
  inputId: string,
  sha256Value: string,
): string {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(inputId) ||
    !/^[0-9a-f]{64}$/u.test(sha256Value)
  ) {
    throw new Error("canonical Pages input identity is invalid");
  }
  return `products/inputs/${inputId}/sha256-${sha256Value}/${inputId}`;
}

export interface PagesReadinessInputV1 {
  authority: {
    catalog_sha256: string;
    evidence_definitions_sha256: string;
    pages_registry_sha256: string;
    runtime_bundle_sha256: string;
    site_metadata_sha256: string;
    test_registry_sha256: string;
  };
  catalog: {
    schema: 1;
    kind: "kandelo-vfs-product-catalog";
    products: Array<{ path: string; sha256: string; manifest: JsonObject }>;
  };
  evidence_definitions: {
    path: string;
    source_bytes?: Uint8Array;
    value: {
      schema: 1;
      kind: "kandelo-vfs-evidence-definitions";
      version: number;
      definitions: Array<{
        id: string;
        host: EvidenceHostV1;
        definition_sha256: string;
        [key: string]: unknown;
      }>;
    };
  };
  pages_registry: {
    path: string;
    source_bytes?: Uint8Array;
    value: {
      schema: 1;
      kind: "kandelo-pages-vfs-products";
      products: Array<{ id: string; load: PagesLoadV1 }>;
    };
  };
  test_registry: {
    path: string;
    source_bytes?: Uint8Array;
    value: {
      schema: 1;
      kind: "kandelo-test-vfs-products";
      registrations: Array<{
        product: string;
        node?: string[];
        browser?: string[];
        applicability: Record<string, string>;
      }>;
    };
  };
  runtime_bundle: JsonObject;
  site_metadata: {
    schema: 1;
    kind: "kandelo-pages-site-metadata";
    api: PagesFileIdentityV1;
    browser: PagesFileIdentityV1;
    documentation: PagesFileIdentityV1;
    products: Array<{ id: string; gallery_entries: string[]; vfs_image: string }>;
    files?: PagesFileIdentityV1[];
  };
  source: ExactSourceV1;
  target_abi: TargetAbiV1;
  products: Array<{
    id: string;
    admissions: AdmissionEnvelopeV1[];
    candidate_resolved_inputs: ResolvedVfsProductInputsV1;
    candidate_builder_report: JsonObject;
    canonical_artifacts?: CanonicalInputArtifactV1[];
    current_resolved_inputs: ResolvedVfsProductInputsV1;
  }>;
}

export interface ExactSourceV1 {
  repository: string;
  commit: string;
  tree: string;
}

export interface TargetAbiV1 {
  version: number;
  snapshot_sha256: string;
}

export interface AdmissionEnvelopeV1 {
  immutable_reference: string;
  record_sha256: string;
  record: JsonObject;
}

interface AuthenticatedAdmissionEnvelopeV1 extends AdmissionEnvelopeV1 {
  canonical_bottle_layer: {
    body: Uint8Array;
    bytes: number;
    sha256: string;
  };
  canonical_vfs_composition_descriptor: {
    body: Uint8Array;
    bytes: number;
    immutable_reference: string;
    sha256: string;
  };
}

export interface CanonicalOciReadbackV1 {
  bottle_layer: Uint8Array;
  bottle_metadata: Uint8Array;
  config: Uint8Array;
  manifest: Uint8Array;
  vfs_composition_descriptor: Uint8Array;
}

export interface CanonicalInputArtifactV1 {
  input_id: string;
  sha256: string;
  bytes: number;
  reference: string;
  descriptor_reference?: string;
}

export interface ResolvedVfsProductInputsV1 extends JsonObject {
  schema: 1;
  kind: "kandelo-resolved-vfs-product-inputs";
  reference_class: "candidate" | "canonical";
  product: JsonObject;
  source: ExactSourceV1;
  target_abi: TargetAbiV1;
  build_environment: JsonObject;
  inputs: ResolvedVfsInputV1[];
}

interface ResolvedVfsInputV1 extends JsonObject {
  id: string;
  kind: string;
  role: string;
  architecture: string;
  declared_materialization: string;
  effective_materialization: string;
  sha256: string;
  bytes: number;
  reference?: string;
  path?: string;
  descriptor?: {
    sha256: string;
    bytes: number;
    reference: string;
    path: string;
  };
}

export interface CanonicalProductIdentityV1 {
  id: string;
  sha256: string;
  bytes: number;
  reference: string;
  vfs: Uint8Array;
}

export interface CanonicalProductBuildRequestV1 {
  canonical_homebrew_layers: Array<{
    body: Uint8Array;
    bytes: number;
    input_id: string;
    sha256: string;
  }>;
  canonical_homebrew_descriptors: Array<{
    body: Uint8Array;
    bytes: number;
    input_id: string;
    reference: string;
    sha256: string;
  }>;
  canonical_product_inputs: CanonicalProductIdentityV1[];
  product: {
    id: string;
    manifest_path: string;
    manifest_sha256: string;
    architecture: string;
    output: string;
    manifest: JsonObject;
  };
  resolved_inputs: ResolvedVfsProductInputsV1;
}

export interface PagesEvidenceRequestV1 {
  host: EvidenceHostV1;
  definition_id: string;
  definition_sha256: string;
  product: CanonicalProductBuildRequestV1["product"];
  resolved_inputs: ResolvedVfsProductInputsV1;
  builder_report: JsonObject;
  vfs: Uint8Array;
  runtime_bundle_sha256: string;
}

export interface PagesReadinessDependencies {
  buildProduct(
    request: CanonicalProductBuildRequestV1,
  ): Promise<{ builder_report: JsonObject; vfs: Uint8Array }>;
  runEvidence(request: PagesEvidenceRequestV1): Promise<JsonObject>;
  validateAdmissionRecord(recordBytes: Uint8Array): Promise<void>;
  fetchCanonicalOci(immutableReference: string): Promise<CanonicalOciReadbackV1>;
  /** Private, in-process destination. Production binds this beneath producer staging. */
  private_product_root?: string;
}

interface PagesBlockerV1 {
  kind: string;
  guard_code: "pages_product_incomplete";
  product_id?: string;
  detail: string;
}

interface PagesReadyProductV1 {
  id: string;
  load: PagesLoadV1;
  manifest_sha256: string;
  admissions: Array<{ immutable_reference: string; record_sha256: string }>;
  resolved_inputs_sha256: string;
  vfs_sha256: string;
  vfs_bytes: number;
  builder_report_sha256: string;
  runtime_evidence_sha256: string;
  node_receipts: Array<{ id: string; sha256: string }>;
  browser_receipts: Array<{ id: string; sha256: string }>;
}

interface PagesReadinessRecordV1 {
  blockers: PagesBlockerV1[];
  kind: "kandelo-pages-readiness";
  pages_registry: {
    path: string;
    products: Array<{ id: string; load: PagesLoadV1 }>;
    sha256: string;
  };
  products: PagesReadyProductV1[];
  ready: boolean;
  schema: 1;
  site_metadata_sha256: string | null;
  source: ExactSourceV1;
  target_abi: TargetAbiV1;
}

interface PagesFileIdentityV1 {
  bytes: number;
  path: string;
  sha256: string;
}

interface PagesSiteManifestV1 {
  builds: {
    api: PagesFileIdentityV1;
    browser: PagesFileIdentityV1;
    documentation: PagesFileIdentityV1;
  };
  files: PagesFileIdentityV1[];
  kind: "kandelo-pages-site-manifest";
  pages_registry: PagesReadinessRecordV1["pages_registry"];
  products: Array<PagesReadyProductV1 & { path: string }>;
  readiness_record_sha256: string;
  schema: 1;
  site_metadata_sha256: string;
  source: ExactSourceV1;
  target_abi: TargetAbiV1;
}

export interface PagesReadinessResultV1 {
  artifacts?: PagesProductArtifactV1[];
  readiness: PagesReadinessRecordV1;
  site_manifest?: PagesSiteManifestV1;
}

export interface PreparedPagesProductV1 {
  bytes: number;
  id: string;
  load: PagesLoadV1;
  path: string;
  private_path: string;
  sha256: string;
}

export interface PreparedPagesProductsV1 {
  blockers: PagesBlockerV1[];
  sealed_products: PreparedPagesProductV1[];
}

export interface PagesProductArtifactV1 {
  browser_receipts: JsonObject[];
  builder_report: JsonObject;
  id: string;
  node_receipts: JsonObject[];
  resolved_inputs: ResolvedVfsProductInputsV1;
  vfs: Uint8Array;
}

interface PrivatePreparedPagesProductsV1 {
  artifacts: PagesProductArtifactV1[];
  blockers: PagesBlockerV1[];
  input_identity: string;
  products: PagesReadyProductV1[];
  sealed_products: PreparedPagesProductV1[];
}

const privatePreparedPagesProducts = new WeakMap<
  PreparedPagesProductsV1,
  PrivatePreparedPagesProductsV1
>();

interface RecomposeOptionsV1 {
  admissions: AuthenticatedAdmissionEnvelopeV1[];
  candidateResolvedInputs: ResolvedVfsProductInputsV1;
  canonicalProducts: Map<string, CanonicalProductIdentityV1>;
  currentResolvedInputs: ResolvedVfsProductInputsV1;
  currentSource?: ExactSourceV1;
  targetAbi: TargetAbiV1;
  canonicalArtifacts?: CanonicalInputArtifactV1[];
}

class ReadinessError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message);
  }
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  const normalize = (candidate: unknown): unknown => {
    if (
      candidate === null || typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return candidate;
    }
    if (typeof candidate === "number") {
      if (!Number.isSafeInteger(candidate)) {
        throw new Error("canonical JSON permits safe integer numbers only");
      }
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (typeof candidate !== "object") {
      throw new Error("canonical JSON value contains an unsupported type");
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

export function recomposeCanonicalResolvedInputs(
  options: RecomposeOptionsV1,
): ResolvedVfsProductInputsV1 {
  const candidate = structuredClone(options.candidateResolvedInputs);
  if (
    candidate.schema !== 1 ||
    candidate.kind !== "kandelo-resolved-vfs-product-inputs" ||
    candidate.reference_class !== "candidate"
  ) {
    throw new ReadinessError("candidate-input-invalid", "candidate resolved inputs have unsupported identity");
  }
  if (!jsonEqual(candidate.target_abi, options.targetAbi)) {
    throw new ReadinessError("abi-mismatch", "candidate resolved inputs name another target ABI");
  }
  const recaptured = structuredClone(options.currentResolvedInputs);
  if (
    recaptured.schema !== 1 ||
    recaptured.kind !== "kandelo-resolved-vfs-product-inputs" ||
    recaptured.reference_class !== "candidate" ||
    !jsonEqual(recaptured.target_abi, options.targetAbi)
  ) {
    throw new ReadinessError(
      "current-input-invalid",
      "current-main recaptured inputs have unsupported identity",
    );
  }
  if (!jsonEqual(recapturedInputIdentity(candidate), recapturedInputIdentity(recaptured))) {
    throw new ReadinessError(
      "current-input-invalid",
      "current-main recaptured inputs differ from the candidate-proven input identity",
    );
  }
  const canonicalArtifacts = new Map(
    (options.canonicalArtifacts ?? []).map((artifact) => [artifact.input_id, artifact]),
  );
  const inputs = recaptured.inputs.map((input) => {
    const next = structuredClone(input);
    if (input.kind === "homebrew-bottle") {
      const formula = input.id.replace(/^homebrew-/u, "");
      if (formula === input.id) {
        throw new ReadinessError("admission-invalid", `Homebrew input ${input.id} has no Formula identity`);
      }
      const admission = exactAdmission(options.admissions, formula);
      validateAdmission(admission, input, formula, options.targetAbi);
      const repository = canonicalRepository(admission.record.admission.canonical.immutable_reference);
      next.reference = `${repository}@sha256:${input.sha256}`;
      if (next.descriptor !== undefined) {
        const descriptor = admission.canonical_vfs_composition_descriptor;
        next.descriptor.sha256 = descriptor.sha256;
        next.descriptor.bytes = descriptor.bytes;
        next.descriptor.reference = descriptor.immutable_reference;
      }
    } else if (input.kind === "product-image") {
      const dependency = input.id.replace(/^product-/u, "");
      const product = options.canonicalProducts.get(dependency);
      if (product === undefined) {
        throw new ReadinessError(
          "unpromoted-dependency",
          `product dependency ${dependency} has no canonical final image`,
        );
      }
      next.sha256 = product.sha256;
      next.bytes = product.bytes;
      next.reference = product.reference;
    } else if (
      input.effective_materialization === "lazy-reference" &&
      (canonicalArtifacts.has(input.id) || containsCandidateNamespace(next))
    ) {
      const artifact = canonicalArtifacts.get(input.id);
      if (
        artifact === undefined || artifact.sha256 !== input.sha256 ||
        artifact.bytes !== input.bytes
      ) {
        throw new ReadinessError(
          "candidate-reference",
          `input ${input.id} lacks an exact canonical public layer`,
        );
      }
      requireCanonicalInputReference(
        artifact.reference,
        input.id,
        input.sha256,
        input.bytes,
        `input ${input.id}`,
      );
      next.reference = artifact.reference;
      if (next.descriptor !== undefined) {
        if (artifact.descriptor_reference === undefined) {
          throw new ReadinessError(
            "candidate-reference",
            `input ${input.id} lacks a canonical descriptor reference`,
          );
        }
        requireCanonicalInputReference(
          artifact.descriptor_reference,
          input.id,
          next.descriptor.sha256,
          next.descriptor.bytes,
          `input ${input.id} descriptor`,
        );
        next.descriptor.reference = artifact.descriptor_reference;
      }
    } else if (canonicalArtifacts.has(input.id)) {
      throw new ReadinessError(
        "candidate-reference",
        `non-lazy input ${input.id} cannot claim a canonical Pages artifact`,
      );
    }
    if (containsCandidateNamespace(next)) {
      throw new ReadinessError(
        "candidate-reference",
        `canonical input ${input.id} retains the candidate namespace`,
      );
    }
    return next;
  });
  const result = {
    ...recaptured,
    inputs,
    reference_class: "canonical" as const,
    ...(options.currentSource === undefined
      ? {}
      : { source: structuredClone(options.currentSource) }),
  };
  if (containsCandidateNamespace(result)) {
    throw new ReadinessError("candidate-reference", "canonical inputs retain the candidate namespace");
  }
  return result;
}

function recapturedInputIdentity(resolved: ResolvedVfsProductInputsV1): unknown {
  return resolved.inputs.map((input) => {
    const { path: _path, reference: _reference, descriptor, ...identity } = input;
    const stableIdentity = input.kind === "repository-path"
      ? Object.fromEntries(Object.entries(identity).filter(
        ([key]) => key !== "bytes" && key !== "sha256",
      ))
      : identity;
    if (descriptor === undefined) return stableIdentity;
    const {
      path: _descriptorPath,
      reference: _descriptorReference,
      ...descriptorIdentity
    } = descriptor;
    return { ...stableIdentity, descriptor: descriptorIdentity };
  });
}

export async function computePagesReadiness(
  input: PagesReadinessInputV1,
  dependencies: PagesReadinessDependencies,
): Promise<PagesReadinessResultV1> {
  const pages = [...input.pages_registry.value.products]
    .sort((left, right) => ordinal(left.id, right.id));
  const pageIds = new Set(pages.map(({ id }) => id));
  const galleryIds = new Set(input.site_metadata.products.map(({ id }) => id));
  const missingGallery = pages.find(({ id }) => !galleryIds.has(id));
  if (missingGallery !== undefined) {
    return heldPagesResult(input, [
      blocker("gallery-product-missing", `site metadata omits ${missingGallery.id}`),
    ]);
  }
  const extraGallery = input.site_metadata.products.find(({ id }) => !pageIds.has(id));
  if (extraGallery !== undefined) {
    return heldPagesResult(input, [
      blocker("gallery-product-extra", `site metadata adds ${extraGallery.id}`),
    ]);
  }
  if (digest(input.site_metadata) !== input.authority.site_metadata_sha256) {
    return heldPagesResult(input, [
      blocker("site-metadata-stale", "site metadata differs from exact current main"),
    ]);
  }
  const privateRoot = mkdtempSync(join(tmpdir(), "kandelo-pages-products-"));
  try {
    const prepared = await preparePagesProducts(input, {
      ...dependencies,
      private_product_root: privateRoot,
    });
    return finalizePagesReadiness(input, prepared, input.site_metadata);
  } finally {
    rmSync(privateRoot, { force: true, recursive: true });
  }
}

export async function preparePagesProducts(
  input: PagesReadinessInputV1,
  dependencies: PagesReadinessDependencies,
): Promise<PreparedPagesProductsV1> {
  const blockers: PagesBlockerV1[] = [];
  const pages = [...input.pages_registry.value.products]
    .sort((left, right) => ordinal(left.id, right.id));
  for (const { id } of pages) {
    if (!STABLE_ID.test(id)) {
      throw new Error(`Pages product id ${JSON.stringify(id)} is not a stable identifier`);
    }
  }
  const privateRoot = exactEmptyPrivateProductRoot(dependencies.private_product_root);
  const finish = (
    products: PagesReadyProductV1[] = [],
    artifacts: PagesProductArtifactV1[] = [],
    sealedProducts: PreparedPagesProductV1[] = [],
  ): PreparedPagesProductsV1 => {
    const prepared: PreparedPagesProductsV1 = {
      blockers: structuredClone(blockers),
      sealed_products: sealedProducts,
    };
    privatePreparedPagesProducts.set(prepared, {
      artifacts,
      blockers: structuredClone(blockers),
      input_identity: pagesPreparationIdentity(input),
      products,
      sealed_products: structuredClone(sealedProducts),
    });
    return prepared;
  };
  const globalFailure = (kind: string, detail: string): PreparedPagesProductsV1 => {
    blockers.push(blocker(kind, detail));
    return finish();
  };

  const staleManifest = input.catalog.products.find(
    (entry) => entry.sha256 !== digest(entry.manifest),
  );
  if (staleManifest !== undefined || digest(input.catalog) !== input.authority.catalog_sha256) {
    return globalFailure("manifest-stale", "canonical product catalog differs from current main");
  }
  if (
    sourceDigest(input.pages_registry) !== input.authority.pages_registry_sha256 ||
    sourceDigest(input.test_registry) !== input.authority.test_registry_sha256 ||
    sourceDigest(input.evidence_definitions) !== input.authority.evidence_definitions_sha256
  ) {
    return globalFailure("registry-stale", "consumer registry differs from current main");
  }
  const evidenceDefinitions = validatedEvidenceDefinitions(input.evidence_definitions.value);
  if (
    digest(input.runtime_bundle) !== input.authority.runtime_bundle_sha256 ||
    !jsonEqual(input.runtime_bundle.source, input.source) ||
    !jsonEqual(input.runtime_bundle.target_abi, input.target_abi)
  ) {
    return globalFailure("runtime-stale", "runtime identity differs from exact current main");
  }
  const pageIds = new Set(pages.map(({ id }) => id));

  const catalog = new Map(input.catalog.products.map((entry) => [entry.manifest.id, entry]));
  const candidates = new Map(input.products.map((product) => [product.id, product]));
  const tests = new Map(
    input.test_registry.value.registrations.map((registration) => [registration.product, registration]),
  );
  const order = topologicalPagesOrder(pages.map(({ id }) => id), catalog, pageIds, blockers);
  const finalProducts = new Map<string, CanonicalProductIdentityV1>();
  const ready = new Map<string, PagesReadyProductV1>();
  const artifacts = new Map<string, PagesProductArtifactV1>();
  const sealedProducts = new Map<string, PreparedPagesProductV1>();

  for (const id of order) {
    const page = pages.find((entry) => entry.id === id)!;
    const entry = catalog.get(id);
    const candidate = candidates.get(id);
    if (entry === undefined || candidate === undefined) {
      blockers.push(blocker("manifest-stale", `Pages product ${id} lacks current inputs`, id));
      continue;
    }
    const dependenciesIds = productDependencies(entry.manifest);
    const unavailable = dependenciesIds.find((dependency) => !finalProducts.has(dependency));
    if (unavailable !== undefined) {
      blockers.push(
        blocker(
          "unpromoted-dependency",
          `${id} depends on unavailable canonical product ${unavailable}`,
          id,
        ),
      );
      continue;
    }
    const product = {
      architecture: entry.manifest.architecture,
      id,
      manifest: entry.manifest,
      manifest_path: entry.path,
      manifest_sha256: entry.sha256,
      output: entry.manifest.output,
    };
    let resolved: ResolvedVfsProductInputsV1;
    let authenticatedAdmissions: AuthenticatedAdmissionEnvelopeV1[];
    try {
      const candidateSource = candidate.candidate_resolved_inputs.source;
      if (
        candidateSource.repository !== input.source.repository ||
        candidateSource.tree !== input.source.tree
      ) {
        throw new ReadinessError(
          "candidate-input-invalid",
          `${id} candidate inputs name another exact source tree`,
        );
      }
      const expectedCandidateProduct = {
        architecture: product.architecture,
        id: product.id,
        manifest_path: product.manifest_path,
        manifest_sha256: product.manifest_sha256,
        output: product.output,
      };
      if (!jsonEqual(candidate.candidate_resolved_inputs.product, expectedCandidateProduct)) {
        throw new ReadinessError(
          "candidate-input-invalid",
          `${id} candidate inputs differ from the protected product manifest`,
        );
      }
      const expectedDevShellLock = runtimeDevShellLock(input.runtime_bundle);
      if (
        candidate.candidate_resolved_inputs.build_environment?.policy_sha256 !==
          input.runtime_bundle.build_policy_sha256 ||
        candidate.candidate_resolved_inputs.build_environment?.dev_shell_lock_sha256 !==
          expectedDevShellLock
      ) {
        throw new ReadinessError(
          "candidate-input-invalid",
          `${id} candidate inputs use another build policy or dev-shell lock`,
        );
      }
      const currentResolved = candidate.current_resolved_inputs;
      if (
        currentResolved === undefined ||
        (
          !jsonEqual(currentResolved.source, input.source) ||
          !jsonEqual(currentResolved.product, expectedCandidateProduct) ||
          currentResolved.build_environment?.policy_sha256 !==
            input.runtime_bundle.build_policy_sha256 ||
          currentResolved.build_environment?.dev_shell_lock_sha256 !==
            expectedDevShellLock
        )
      ) {
        throw new ReadinessError(
          "current-input-invalid",
          `${id} current-main recapture differs from the exact source, product, or runtime`,
        );
      }
      validateCandidateBuilderReport(
        candidate.candidate_builder_report,
        candidate.candidate_resolved_inputs,
      );
      authenticatedAdmissions = await authenticateAdmissions(
        candidate.admissions,
        candidate.candidate_resolved_inputs.inputs,
        input.target_abi,
        dependencies,
      );
      resolved = recomposeCanonicalResolvedInputs({
        admissions: authenticatedAdmissions,
        candidateResolvedInputs: candidate.candidate_resolved_inputs,
        canonicalArtifacts: candidate.canonical_artifacts,
        canonicalProducts: finalProducts,
        currentResolvedInputs: candidate.current_resolved_inputs,
        currentSource: input.source,
        targetAbi: input.target_abi,
      });
    } catch (error) {
      const failure = asReadinessError(error, "canonical-recomposition-failure");
      blockers.push(blocker(failure.kind, failure.message, id));
      continue;
    }

    let built: { builder_report: JsonObject; vfs: Uint8Array };
    try {
      built = await dependencies.buildProduct({
        canonical_homebrew_layers: authenticatedAdmissions.map((admission) => {
          const formula = String(
            admission.record.admission.formula_metadata_update.formula,
          );
          const layer = admission.canonical_bottle_layer;
          return {
            body: new Uint8Array(layer.body),
            bytes: layer.bytes,
            input_id: `homebrew-${formula}`,
            sha256: layer.sha256,
          };
        }),
        canonical_homebrew_descriptors: authenticatedAdmissions.map((admission) => {
          const formula = String(
            admission.record.admission.formula_metadata_update.formula,
          );
          const descriptor = admission.canonical_vfs_composition_descriptor;
          return {
            body: new Uint8Array(descriptor.body),
            bytes: descriptor.bytes,
            input_id: `homebrew-${formula}`,
            reference: descriptor.immutable_reference,
            sha256: descriptor.sha256,
          };
        }),
        canonical_product_inputs: dependenciesIds.map((dependency) => {
          const productInput = finalProducts.get(dependency)!;
          return { ...productInput, vfs: new Uint8Array(productInput.vfs) };
        }),
        product,
        resolved_inputs: resolved,
      });
      await validateFinalBuild(
        product,
        resolved,
        candidate.candidate_resolved_inputs,
        candidate.candidate_builder_report,
        built,
        input.target_abi,
      );
      built = {
        builder_report: structuredClone(built.builder_report),
        vfs: new Uint8Array(built.vfs),
      };
    } catch (error) {
      const failure = asReadinessError(error, "builder-failure");
      blockers.push(blocker(failure.kind, failure.message, id));
      continue;
    }

    const registration = tests.get(id);
    if (registration === undefined) {
      blockers.push(blocker("registry-stale", `Pages product ${id} lacks test ownership`, id));
      continue;
    }
    const nodeIds = sortedUnique(registration.node ?? [], `${id} Node evidence`);
    const browserIds = sortedUnique(registration.browser ?? [], `${id} browser evidence`);
    if (nodeIds.length === 0 || browserIds.length === 0) {
      blockers.push(
        blocker("registry-stale", `${id} lacks required Node or browser evidence`, id),
      );
      continue;
    }
    const nodeReceipts: Array<{ id: string; sha256: string }> = [];
    const browserReceipts: Array<{ id: string; sha256: string }> = [];
    const nodeReceiptArtifacts: JsonObject[] = [];
    const browserReceiptArtifacts: JsonObject[] = [];
    let evidenceFailed = false;
    for (const [host, ids, output, receiptArtifacts] of [
      ["node", nodeIds, nodeReceipts, nodeReceiptArtifacts],
      ["browser", browserIds, browserReceipts, browserReceiptArtifacts],
    ] as const) {
      for (const definitionId of ids) {
        const definition = evidenceDefinitions.get(definitionId);
        if (definition === undefined || definition.host !== host) {
          blockers.push(
            blocker(
              "registry-stale",
              `${definitionId} is absent from the protected ${host} evidence registry`,
              id,
            ),
          );
          evidenceFailed = true;
          break;
        }
        const request: PagesEvidenceRequestV1 = {
          builder_report: built.builder_report,
          definition_id: definitionId,
          definition_sha256: definition.definition_sha256,
          host,
          product,
          resolved_inputs: resolved,
          runtime_bundle_sha256: input.authority.runtime_bundle_sha256,
          vfs: new Uint8Array(built.vfs),
        };
        try {
          const receipt = await dependencies.runEvidence(request);
          validateEvidenceReceipt(receipt, request);
          if (receipt.outcome !== "success") {
            blockers.push(
              blocker(
                `${host}-evidence-${receipt.outcome}`,
                `${definitionId} ended with ${receipt.outcome}`,
                id,
              ),
            );
            evidenceFailed = true;
            break;
          }
          const exactReceipt = structuredClone(receipt);
          output.push({ id: definitionId, sha256: digest(exactReceipt) });
          receiptArtifacts.push(exactReceipt);
        } catch (error) {
          blockers.push(
            blocker(
              `${host}-evidence-failure`,
              `${definitionId} failed validation: ${errorMessage(error)}`,
              id,
            ),
          );
          evidenceFailed = true;
          break;
        }
      }
      if (evidenceFailed) break;
    }
    if (evidenceFailed) continue;

    const vfsSha = sha256(built.vfs);
    const reportSha = digest(built.builder_report);
    const admissionLinks = candidate.admissions
      .map(({ immutable_reference, record_sha256 }) => ({ immutable_reference, record_sha256 }))
      .sort((left, right) => ordinal(left.record_sha256, right.record_sha256));
    const completed: PagesReadyProductV1 = {
      admissions: admissionLinks,
      browser_receipts: browserReceipts,
      builder_report_sha256: reportSha,
      id,
      load: page.load,
      manifest_sha256: entry.sha256,
      node_receipts: nodeReceipts,
      resolved_inputs_sha256: digest(resolved),
      runtime_evidence_sha256: digest({
        browser_receipts: browserReceipts,
        node_receipts: nodeReceipts,
        runtime_bundle_sha256: input.authority.runtime_bundle_sha256,
      }),
      vfs_bytes: built.vfs.byteLength,
      vfs_sha256: vfsSha,
    };
    ready.set(id, completed);
    const privatePath = resolve(privateRoot, `${id}.vfs.zst`);
    if (dirname(privatePath) !== privateRoot) {
      throw new Error(`Pages product id ${JSON.stringify(id)} escapes the private product root`);
    }
    writeFileSync(privatePath, built.vfs, { flag: "wx", mode: 0o600 });
    sealedProducts.set(id, {
      bytes: built.vfs.byteLength,
      id,
      load: page.load,
      path: productSitePath(completed, input.target_abi.version),
      private_path: privatePath,
      sha256: vfsSha,
    });
    artifacts.set(id, {
      browser_receipts: browserReceiptArtifacts,
      builder_report: structuredClone(built.builder_report),
      id,
      node_receipts: nodeReceiptArtifacts,
      resolved_inputs: structuredClone(resolved),
      vfs: new Uint8Array(built.vfs),
    });
    finalProducts.set(id, {
      bytes: built.vfs.byteLength,
      id,
      reference: canonicalProductReference(
        input.target_abi.version,
        id,
        vfsSha,
        built.vfs.byteLength,
      ),
      sha256: vfsSha,
      vfs: new Uint8Array(built.vfs),
    });
  }
  return finish(
    [...ready.values()].sort((left, right) => ordinal(left.id, right.id)),
    [...artifacts.values()].sort((left, right) => ordinal(left.id, right.id)),
    [...sealedProducts.values()].sort((left, right) => ordinal(left.id, right.id)),
  );
}

function heldPagesResult(
  input: PagesReadinessInputV1,
  blockers: PagesBlockerV1[],
): PagesReadinessResultV1 {
  return {
    readiness: {
      blockers,
      kind: "kandelo-pages-readiness",
      pages_registry: {
        path: input.pages_registry.path,
        products: [...input.pages_registry.value.products]
          .sort((left, right) => ordinal(left.id, right.id)),
        sha256: input.authority.pages_registry_sha256,
      },
      products: [],
      ready: false,
      schema: 1,
      site_metadata_sha256: null,
      source: input.source,
      target_abi: input.target_abi,
    },
  };
}

export function finalizePagesReadiness(
  input: PagesReadinessInputV1,
  prepared: PreparedPagesProductsV1,
  siteMetadata: PagesReadinessInputV1["site_metadata"],
): PagesReadinessResultV1 {
  const state = privatePreparedPagesProducts.get(prepared);
  if (state === undefined) {
    throw new Error("Pages products were not prepared by this process");
  }
  if (state.input_identity !== pagesPreparationIdentity(input)) {
    throw new Error("Pages preparation authority changed before finalization");
  }
  const pages = [...input.pages_registry.value.products]
    .sort((left, right) => ordinal(left.id, right.id));
  const base = (
    blockers: PagesBlockerV1[],
    products: PagesReadyProductV1[] = [],
    siteMetadataSha256: string | null = null,
  ): PagesReadinessRecordV1 => ({
    blockers,
    kind: "kandelo-pages-readiness",
    pages_registry: {
      path: input.pages_registry.path,
      products: pages,
      sha256: input.authority.pages_registry_sha256,
    },
    products,
    ready: blockers.length === 0 && products.length === pages.length,
    schema: 1,
    site_metadata_sha256: siteMetadataSha256,
    source: input.source,
    target_abi: input.target_abi,
  });
  const held = (kind: string, detail: string, productId?: string): PagesReadinessResultV1 => ({
    readiness: base([blocker(kind, detail, productId)]),
  });
  if (state.blockers.length > 0) {
    return { readiness: base(structuredClone(state.blockers)) };
  }

  const actualIds = prepared.sealed_products.map(({ id }) => id);
  const expectedIds = pages.map(({ id }) => id);
  if (!jsonEqual(actualIds, expectedIds)) {
    throw new Error("sealed products must be the exact sorted Pages product set");
  }
  if (!jsonEqual(prepared.sealed_products, state.sealed_products)) {
    throw new Error("sealed products must be the exact sorted Pages product set");
  }
  if (state.products.length !== pages.length || state.artifacts.length !== pages.length) {
    throw new Error("sealed products must be the exact sorted Pages product set");
  }
  const authenticatedArtifacts = state.artifacts.map((artifact, index) => {
    const sealed = state.sealed_products[index]!;
    const product = state.products[index]!;
    if (
      sealed.id !== product.id || sealed.load !== product.load ||
      sealed.bytes !== product.vfs_bytes || sealed.sha256 !== product.vfs_sha256 ||
      sealed.path !== productSitePath(product, input.target_abi.version)
    ) {
      throw new Error("sealed products must be the exact sorted Pages product set");
    }
    const body = readAuthenticatedPrivateProduct(sealed);
    const exactArtifact = structuredClone(artifact);
    exactArtifact.vfs = body;
    return exactArtifact;
  });
  if (
    siteMetadata?.schema !== 1 || siteMetadata.kind !== "kandelo-pages-site-metadata" ||
    !Array.isArray(siteMetadata.products)
  ) {
    return held("site-metadata-invalid", "site metadata has unsupported identity");
  }
  if (containsCandidateNamespace(siteMetadata)) {
    throw new Error("final Pages site metadata contains the candidate namespace");
  }
  const pageIds = new Set(expectedIds);
  const galleryIds = new Set(siteMetadata.products.map(({ id }) => id));
  const missingGallery = pages.find(({ id }) => !galleryIds.has(id));
  if (missingGallery !== undefined) {
    return held("gallery-product-missing", `site metadata omits ${missingGallery.id}`);
  }
  const extraGallery = siteMetadata.products.find(({ id }) => !pageIds.has(id));
  if (extraGallery !== undefined) {
    return held("gallery-product-extra", `site metadata adds ${extraGallery.id}`);
  }
  const siteMetadataSha256 = digest(siteMetadata);
  const declaredFiles = siteMetadata.files ?? [
    siteMetadata.api,
    siteMetadata.browser,
    siteMetadata.documentation,
  ];
  const canonicalProductPaths = new Set(state.sealed_products.map(({ path }) => path));
  const unexpectedVfs = declaredFiles.find(({ path }) =>
    isVfsSpecifier(path) && !canonicalProductPaths.has(path)
  );
  if (unexpectedVfs !== undefined) {
    throw new Error(`final Pages site contains VFS path outside the sealed product set: ${unexpectedVfs.path}`);
  }
  for (const [index, product] of state.products.entries()) {
    try {
      validatePagesInputSiteInventory(state.artifacts[index]!.resolved_inputs.inputs, declaredFiles);
    } catch (error) {
      const failure = asReadinessError(error, "site-metadata-invalid");
      return held(failure.kind, failure.message, product.id);
    }
  }

  const readiness = base([], structuredClone(state.products), siteMetadataSha256);
  const productFiles = state.sealed_products.map(({ bytes, path, sha256: digestValue }) => ({
    bytes,
    path,
    sha256: digestValue,
  }));
  const siteManifest: PagesSiteManifestV1 = {
    builds: {
      api: siteMetadata.api,
      browser: siteMetadata.browser,
      documentation: siteMetadata.documentation,
    },
    files: exactSiteFiles(declaredFiles, productFiles),
    kind: "kandelo-pages-site-manifest",
    pages_registry: readiness.pages_registry,
    products: readiness.products.map((product) => ({
      ...product,
      path: productSitePath(product, input.target_abi.version),
    })),
    readiness_record_sha256: digest(readiness),
    schema: 1,
    site_metadata_sha256: siteMetadataSha256,
    source: readiness.source,
    target_abi: readiness.target_abi,
  };
  if (containsCandidateNamespace({ readiness, site_manifest: siteManifest })) {
    throw new Error("ready Pages result contains the candidate namespace");
  }
  return { artifacts: authenticatedArtifacts, readiness, site_manifest: siteManifest };
}

function exactEmptyPrivateProductRoot(value: string | undefined): string {
  if (value === undefined || resolve(value) !== value) {
    throw new Error("Pages preparation requires an absolute private product root");
  }
  const metadata = lstatSync(value);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || readdirSync(value).length !== 0) {
    throw new Error("Pages private product root must be an empty direct directory");
  }
  return value;
}

function readAuthenticatedPrivateProduct(sealed: PreparedPagesProductV1): Uint8Array {
  let metadata;
  try {
    metadata = lstatSync(sealed.private_path);
  } catch {
    throw new Error(`sealed product ${sealed.id} differs from its authenticated identity`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== sealed.bytes) {
    throw new Error(`sealed product ${sealed.id} differs from its authenticated identity`);
  }
  const body = new Uint8Array(readFileSync(sealed.private_path));
  if (body.byteLength !== sealed.bytes || sha256(body) !== sealed.sha256) {
    throw new Error(`sealed product ${sealed.id} differs from its authenticated identity`);
  }
  return body;
}

function pagesPreparationIdentity(input: PagesReadinessInputV1): string {
  return digest({
    authority: {
      catalog_sha256: input.authority.catalog_sha256,
      evidence_definitions_sha256: input.authority.evidence_definitions_sha256,
      pages_registry_sha256: input.authority.pages_registry_sha256,
      runtime_bundle_sha256: input.authority.runtime_bundle_sha256,
      test_registry_sha256: input.authority.test_registry_sha256,
    },
    catalog: input.catalog,
    evidence_definitions: input.evidence_definitions,
    pages_registry: input.pages_registry,
    products: input.products,
    runtime_bundle: input.runtime_bundle,
    source: input.source,
    target_abi: input.target_abi,
    test_registry: input.test_registry,
  });
}

function exactAdmission(
  admissions: AuthenticatedAdmissionEnvelopeV1[],
  formula: string,
): AuthenticatedAdmissionEnvelopeV1 {
  const matches = admissions.filter(
    ({ record }) => record?.admission?.formula_metadata_update?.formula === formula,
  );
  if (matches.length !== 1) {
    throw new ReadinessError("missing-admission", `Formula ${formula} lacks one exact admission`);
  }
  return matches[0];
}

function validateAdmission(
  envelope: AuthenticatedAdmissionEnvelopeV1,
  input: ResolvedVfsInputV1,
  formula: string,
  targetAbi: TargetAbiV1,
): void {
  const record = envelope.record;
  if (
    record.schema !== 1 || record.kind !== "kandelo-abi-staging-admission" ||
    record.common?.outcome !== "success" || record.common?.promotion_state !== "promoted"
  ) {
    throw new ReadinessError("admission-invalid", `Formula ${formula} admission is not successful`);
  }
  const update = record.admission?.formula_metadata_update;
  if (update?.target_abi !== targetAbi.version) {
    throw new ReadinessError("abi-mismatch", `Formula ${formula} admission names another ABI`);
  }
  if (update?.architecture !== input.architecture) {
    throw new ReadinessError(
      "architecture-mismatch",
      `Formula ${formula} admission names another architecture`,
    );
  }
  const layer = record.admission?.promoted_layer;
  if (
    layer?.sha256 !== input.sha256 || layer?.bytes !== input.bytes ||
    update.bottle_layer_sha256 !== input.sha256 || update.bottle_layer_bytes !== input.bytes
  ) {
    throw new ReadinessError("layer-mismatch", `Formula ${formula} promoted layer differs`);
  }
  if (digest(envelope.record) !== envelope.record_sha256) {
    throw new ReadinessError("admission-invalid", `Formula ${formula} admission digest differs`);
  }
  const canonical = record.admission?.canonical;
  if (
    canonical?.sha256 !== update.canonical_manifest_digest ||
    canonical?.sha256 !== record.common?.artifact?.sha256 ||
    canonical?.bytes !== record.common?.artifact?.bytes ||
    canonical?.immutable_reference !== record.common?.artifact?.immutable_reference
  ) {
    throw new ReadinessError("admission-invalid", `Formula ${formula} canonical admission differs`);
  }
  if (record.admission?.canonical_public_readback_sha256 !== canonical.sha256) {
    throw new ReadinessError(
      "admission-invalid",
      `Formula ${formula} canonical public readback differs`,
    );
  }
  requireCanonicalReference(canonical.immutable_reference, canonical.sha256, `Formula ${formula}`);
  const descriptor = envelope.canonical_vfs_composition_descriptor;
  if (
    input.descriptor === undefined || descriptor === undefined ||
    !(descriptor.body instanceof Uint8Array) ||
    !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes <= 0 ||
    descriptor.bytes !== descriptor.body.byteLength ||
    descriptor.sha256 !== sha256(descriptor.body)
  ) {
    throw new ReadinessError(
      "admission-invalid",
      `Formula ${formula} lacks the exact canonical VFS composition descriptor`,
    );
  }
  requireCanonicalReference(
    descriptor.immutable_reference,
    descriptor.sha256,
    `Formula ${formula} canonical VFS composition descriptor`,
  );
  if (
    canonicalRepository(descriptor.immutable_reference) !==
      canonicalRepository(canonical.immutable_reference)
  ) {
    throw new ReadinessError(
      "admission-invalid",
      `Formula ${formula} canonical VFS descriptor uses another repository`,
    );
  }
  const expectedAdmissionPrefix =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${targetAbi.version}/${formula}/admissions@sha256:`;
  if (
    !envelope.immutable_reference.startsWith(expectedAdmissionPrefix) ||
    !/^[0-9a-f]{64}$/u.test(envelope.immutable_reference.slice(expectedAdmissionPrefix.length)) ||
    envelope.immutable_reference !==
      `${expectedAdmissionPrefix}${envelope.immutable_reference.slice(expectedAdmissionPrefix.length)}`
  ) {
    throw new ReadinessError(
      "admission-invalid",
      `Formula ${formula} admission envelope is not one immutable manifest locator`,
    );
  }
}

async function authenticateAdmissions(
  admissions: AdmissionEnvelopeV1[],
  inputs: ResolvedVfsInputV1[],
  targetAbi: TargetAbiV1,
  dependencies: PagesReadinessDependencies,
): Promise<AuthenticatedAdmissionEnvelopeV1[]> {
  const bottles = inputs.filter((input) => input.kind === "homebrew-bottle");
  const authenticated: AuthenticatedAdmissionEnvelopeV1[] = [];
  for (const input of bottles) {
    const formula = input.id.replace(/^homebrew-/u, "");
    if (formula === input.id) {
      throw new ReadinessError("admission-invalid", `Homebrew input ${input.id} has no Formula identity`);
    }
    const matches = admissions.filter(
      ({ record }) => record?.admission?.formula_metadata_update?.formula === formula,
    );
    if (matches.length !== 1) {
      throw new ReadinessError("missing-admission", `Formula ${formula} lacks one exact admission`);
    }
    const envelope = matches[0]!;
    try {
      await dependencies.validateAdmissionRecord(canonicalJsonBytes(envelope.record));
      const canonical = envelope.record?.admission?.canonical;
      if (typeof canonical?.immutable_reference !== "string") {
        throw new Error("admission lacks a canonical immutable reference");
      }
      const readback = await dependencies.fetchCanonicalOci(canonical.immutable_reference);
      const canonicalLayers = validateCanonicalBottleReadback(
        readback,
        envelope,
        input,
        formula,
        targetAbi,
      );
      authenticated.push({
        ...structuredClone(envelope),
        ...canonicalLayers,
      });
    } catch (error) {
      throw new ReadinessError(
        "admission-invalid",
        `Formula ${formula} admission authentication failed: ${errorMessage(error)}`,
      );
    }
  }
  if (admissions.length !== authenticated.length) {
    throw new ReadinessError(
      "admission-invalid",
      "product admissions include a record outside its exact Homebrew bottle inputs",
    );
  }
  return authenticated;
}

function validateCanonicalBottleReadback(
  readback: CanonicalOciReadbackV1,
  envelope: AdmissionEnvelopeV1,
  input: ResolvedVfsInputV1,
  formula: string,
  targetAbi: TargetAbiV1,
): Pick<
  AuthenticatedAdmissionEnvelopeV1,
  "canonical_bottle_layer" | "canonical_vfs_composition_descriptor"
> {
  const record = envelope.record;
  const canonical = record.admission?.canonical;
  if (
    typeof canonical?.sha256 !== "string" ||
    sha256(readback.manifest) !== canonical.sha256 ||
    readback.manifest.byteLength !== canonical.bytes ||
    record.admission?.canonical_public_readback_sha256 !== canonical.sha256
  ) {
    throw new Error("canonical OCI manifest differs from the admitted public readback");
  }
  const manifest = canonicalJsonValue(readback.manifest, "canonical OCI manifest");
  exactKeys(
    manifest,
    ["annotations", "artifactType", "config", "layers", "mediaType", "schemaVersion"],
    "canonical OCI manifest",
  );
  const artifactType = "application/vnd.kandelo.homebrew.canonical-bottle.v1+json";
  if (
    manifest.schemaVersion !== 2 ||
    manifest.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    manifest.artifactType !== artifactType ||
    !Array.isArray(manifest.layers) || manifest.layers.length !== 3
  ) {
    throw new Error("canonical OCI manifest has unsupported identity");
  }
  const configDescriptor = validatedOciDescriptor(
    manifest.config,
    "canonical-bottle-metadata",
    artifactType,
    "canonical OCI config",
  );
  validateDescriptorBody(configDescriptor, readback.config, "canonical OCI config");
  const bottleDescriptor = validatedOciDescriptor(
    manifest.layers[0],
    "bottle-layer",
    "application/vnd.kandelo.homebrew.bottle.layer.v1+tar+gzip",
    "canonical bottle layer",
  );
  const metadataDescriptor = validatedOciDescriptor(
    manifest.layers[1],
    "bottle-metadata",
    "application/vnd.kandelo.homebrew.bottle.metadata.v1+json",
    "canonical bottle metadata",
  );
  const compositionDescriptor = validatedOciDescriptor(
    manifest.layers[2],
    "vfs-composition-descriptor",
    "application/vnd.kandelo.homebrew.vfs-composition-descriptor.v1+json",
    "canonical VFS composition descriptor",
  );
  validateDescriptorBody(
    bottleDescriptor,
    readback.bottle_layer,
    "canonical bottle layer",
  );
  validateDescriptorBody(
    metadataDescriptor,
    readback.bottle_metadata,
    "canonical bottle metadata",
  );
  validateDescriptorBody(
    compositionDescriptor,
    readback.vfs_composition_descriptor,
    "canonical VFS composition descriptor",
  );
  if (
    bottleDescriptor.sha256 !== input.sha256 || bottleDescriptor.bytes !== input.bytes ||
    input.descriptor === undefined
  ) {
    throw new Error("canonical OCI layers differ from the exact resolved bottle input");
  }
  validateCanonicalCompositionDescriptor(
    readback.vfs_composition_descriptor,
    formula,
    input,
    targetAbi,
    canonicalRepository(canonical.immutable_reference),
  );
  const config = canonicalJsonValue(readback.config, "canonical bottle config");
  const expectedConfig = {
    bottle_layer: { bytes: input.bytes, sha256: input.sha256 },
    bottle_metadata: {
      bytes: metadataDescriptor.bytes,
      sha256: metadataDescriptor.sha256,
    },
    candidate_record_sha256: record.admission.candidate_record_sha256,
    classification: "canonical-pending-admission",
    formula: {
      architecture: input.architecture,
      name: formula,
      tap: "kandelo-dev/homebrew-tap-core",
      target_abi: targetAbi.version,
    },
    kind: "kandelo-homebrew-canonical-bottle",
    merged_pull_request: record.admission.merged_pull_request,
    request_sha256: record.common.request_sha256,
    schema: 1,
    vfs_composition_descriptor: {
      bytes: compositionDescriptor.bytes,
      sha256: compositionDescriptor.sha256,
    },
  };
  if (!jsonEqual(config, expectedConfig)) {
    throw new Error("canonical bottle config differs from the exact admission");
  }
  const expectedAnnotations = {
    "dev.kandelo.abi-staging.candidate-record-sha256":
      record.admission.candidate_record_sha256,
    "dev.kandelo.abi-staging.classification": "canonical-pending-admission",
    "dev.kandelo.abi-staging.formula": formula,
    "dev.kandelo.abi-staging.kind": "canonical-bottle",
    "dev.kandelo.abi-staging.target-abi": String(targetAbi.version),
    "org.opencontainers.image.source":
      "https://github.com/kandelo-dev/homebrew-tap-core",
  };
  if (!jsonEqual(manifest.annotations, expectedAnnotations)) {
    throw new Error("canonical OCI annotations differ from the exact admission");
  }
  const repository = canonicalRepository(canonical.immutable_reference);
  return {
    canonical_bottle_layer: {
      body: new Uint8Array(readback.bottle_layer),
      bytes: bottleDescriptor.bytes,
      sha256: bottleDescriptor.sha256,
    },
    canonical_vfs_composition_descriptor: {
      body: new Uint8Array(readback.vfs_composition_descriptor),
      bytes: compositionDescriptor.bytes,
      immutable_reference: `${repository}@sha256:${compositionDescriptor.sha256}`,
      sha256: compositionDescriptor.sha256,
    },
  };
}

function validateCanonicalCompositionDescriptor(
  bytes: Uint8Array,
  formula: string,
  input: ResolvedVfsInputV1,
  targetAbi: TargetAbiV1,
  canonicalRepositoryValue: string,
): void {
  const value = canonicalJsonValue(bytes, "canonical VFS composition descriptor");
  exactKeys(
    value,
    ["architecture", "formula", "kind", "required_by", "schema", "tap", "tree"],
    "canonical VFS composition descriptor",
  );
  if (
    value.schema !== 1 || value.kind !== "kandelo-homebrew-original-bottle-tree" ||
    value.architecture !== input.architecture || value.formula !== formula ||
    value.tap !== "kandelo-dev/homebrew-tap-core" ||
    !Array.isArray(value.required_by) || value.required_by.length === 0
  ) {
    throw new Error("canonical VFS composition descriptor identity differs");
  }
  exactKeys(
    value.tree,
    ["activation", "content", "id", "inventory", "package", "transports"],
    "canonical VFS composition tree",
  );
  exactKeys(
    value.tree.content,
    ["bytes", "decoder", "media_type", "sha256"],
    "canonical VFS composition content",
  );
  const expectedUrl =
    `https://ghcr.io/v2/${canonicalRepositoryValue.replace(/^ghcr\.io\//u, "")}` +
    `/blobs/sha256:${input.sha256}`;
  if (
    value.tree.id !== formula ||
    value.tree.content.bytes !== input.bytes ||
    value.tree.content.sha256 !== input.sha256 ||
    value.tree.content.decoder !== "homebrew-bottle-tar-gzip-v1" ||
    value.tree.content.media_type !==
      "application/vnd.oci.image.layer.v1.tar+gzip" ||
    !jsonEqual(value.tree.transports, [{ kind: "external-https", url: expectedUrl }]) ||
    containsCandidateNamespace(value)
  ) {
    throw new Error(
      `canonical VFS composition descriptor differs from ABI ${targetAbi.version} bottle`,
    );
  }
}

function validatedOciDescriptor(
  value: unknown,
  role: string,
  mediaType: string,
  label: string,
): { bytes: number; sha256: string } {
  const descriptor = value as JsonObject;
  exactKeys(descriptor, ["annotations", "digest", "mediaType", "size"], label);
  exactKeys(
    descriptor.annotations,
    ["dev.kandelo.abi-staging.role", "org.opencontainers.image.title"],
    `${label} annotations`,
  );
  const digestValue = typeof descriptor.digest === "string"
    ? descriptor.digest.match(/^sha256:([0-9a-f]{64})$/u)?.[1]
    : undefined;
  if (
    descriptor.mediaType !== mediaType ||
    descriptor.annotations["dev.kandelo.abi-staging.role"] !== role ||
    typeof descriptor.annotations["org.opencontainers.image.title"] !== "string" ||
    descriptor.annotations["org.opencontainers.image.title"].length === 0 ||
    digestValue === undefined || !Number.isSafeInteger(descriptor.size) || descriptor.size <= 0
  ) {
    throw new Error(`${label} descriptor is invalid`);
  }
  return { bytes: descriptor.size, sha256: digestValue };
}

function validateDescriptorBody(
  descriptor: { bytes: number; sha256: string },
  body: Uint8Array,
  label: string,
): void {
  if (
    !(body instanceof Uint8Array) || body.byteLength !== descriptor.bytes ||
    sha256(body) !== descriptor.sha256
  ) {
    throw new Error(`${label} body differs from its exact descriptor`);
  }
}

function canonicalJsonValue(bytes: Uint8Array, label: string): JsonObject {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 16 * 1024 * 1024) {
    throw new Error(`${label} is empty or exceeds its byte bound`);
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalJsonBytes(value)))) {
    throw new Error(`${label} is not canonical JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JsonObject;
}

function exactKeys(value: unknown, expected: string[], label: string): asserts value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  const actual = Object.keys(value as JsonObject).sort(ordinal);
  const sortedExpected = [...expected].sort(ordinal);
  if (!jsonEqual(actual, sortedExpected)) throw new Error(`${label} fields changed`);
}

function canonicalRepository(reference: string): string {
  requireCanonicalReferenceShape(reference);
  return reference.replace(/@sha256:[0-9a-f]{64}$/u, "");
}

function requireCanonicalReference(reference: string, digestValue: string, label: string): void {
  requireCanonicalReferenceShape(reference);
  if (!reference.endsWith(`@sha256:${digestValue}`)) {
    throw new ReadinessError("layer-mismatch", `${label} reference differs from its digest`);
  }
}

function requireCanonicalInputReference(
  reference: string,
  inputId: string,
  digestValue: string,
  bytes: number,
  label: string,
): void {
  if (reference === canonicalPagesInputReference(inputId, digestValue, bytes)) return;
  if (reference.startsWith(`${CANONICAL_PAGES_ORIGIN}products/inputs/`)) {
    throw new ReadinessError(
      "layer-mismatch",
      `${label} lacks an exact canonical public layer`,
    );
  }
  requireCanonicalReference(reference, digestValue, label);
}

function validatePagesInputSiteInventory(
  inputs: ResolvedVfsInputV1[],
  files: PagesFileIdentityV1[],
): void {
  const inventory = new Map(files.map((file) => [file.path, file]));
  for (const input of inputs) {
    requirePagesInputSiteFile(
      input.reference,
      input.id,
      input.sha256,
      input.bytes,
      `input ${input.id}`,
      inventory,
    );
    if (input.descriptor !== undefined) {
      requirePagesInputSiteFile(
        input.descriptor.reference,
        input.id,
        input.descriptor.sha256,
        input.descriptor.bytes,
        `input ${input.id} descriptor`,
        inventory,
      );
    }
  }
}

function requirePagesInputSiteFile(
  reference: string | undefined,
  inputId: string,
  digestValue: string,
  bytes: number,
  label: string,
  inventory: Map<string, PagesFileIdentityV1>,
): void {
  if (reference === undefined || !reference.startsWith(
    `${CANONICAL_PAGES_ORIGIN}products/inputs/`,
  )) return;
  requireCanonicalInputReference(reference, inputId, digestValue, bytes, label);
  const path = canonicalPagesInputSitePath(inputId, digestValue);
  const expected = { bytes, path, sha256: digestValue };
  const actual = inventory.get(path);
  if (actual === undefined || !jsonEqual(actual, expected)) {
    throw new ReadinessError(
      "site-input-missing",
      `${label} is absent from the exact Pages site inventory`,
    );
  }
}

function requireCanonicalReferenceShape(reference: string): void {
  if (
    typeof reference !== "string" || reference.includes("-candidates/") ||
    !/^ghcr\.io\/kandelo-dev\/homebrew-tap-core-abi-[0-9]+\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/u
      .test(reference)
  ) {
    throw new ReadinessError("candidate-reference", "reference is not in the canonical ABI namespace");
  }
}

async function validateFinalBuild(
  product: CanonicalProductBuildRequestV1["product"],
  resolved: ResolvedVfsProductInputsV1,
  candidateResolved: ResolvedVfsProductInputsV1,
  candidateReport: JsonObject,
  built: { builder_report: JsonObject; vfs: Uint8Array },
  targetAbi: TargetAbiV1,
): Promise<void> {
  if (!(built.vfs instanceof Uint8Array) || built.vfs.byteLength === 0) {
    throw new ReadinessError("builder-failure", "final builder returned no VFS bytes");
  }
  const report = built.builder_report;
  const expectedInputs = expectedBuilderInputs(resolved);
  const expectedOutput = {
    abi: targetAbi,
    bytes: built.vfs.byteLength,
    name: product.output,
    path: product.output,
    sha256: sha256(built.vfs),
  };
  if (
    report?.schema !== 1 || report?.kind !== "kandelo-vfs-builder-report" ||
    report.capture?.complete !== true || !jsonEqual(report.capture.unreported_reads, []) ||
    report.resolved_inputs_sha256 !== digest(resolved) ||
    !jsonEqual(report.product, resolved.product) ||
    !jsonEqual(report.inputs, expectedInputs) || !jsonEqual(report.output, expectedOutput)
  ) {
    throw new ReadinessError("builder-failure", "final builder report differs from canonical inputs");
  }
  if (containsCandidateNamespace(report)) {
    throw new ReadinessError("candidate-reference", "final builder report contains candidate namespace");
  }
  if (
    digest(resolved) !== digest(candidateResolved) &&
    expectedOutput.sha256 === candidateReport?.output?.sha256
  ) {
    throw new ReadinessError(
      "builder-failure",
      "canonical recomposition did not change a locator-dependent VFS",
    );
  }
  const fs = await restoreVerifiedVfsImage(built.vfs, {
    maxDecompressedBytes: 1024 * 1024 * 1024,
  });
  const metadata = fs.getImageMetadata();
  if (
    metadata?.kernelAbi !== targetAbi.version ||
    metadata?.abiSnapshotSha256 !== targetAbi.snapshot_sha256
  ) {
    throw new ReadinessError("abi-mismatch", "final VFS ABI metadata differs from current main");
  }
  const expectedLazy = new Map(
    resolved.inputs
      .filter((input) => input.effective_materialization === "lazy-reference")
      .map((input) => [input.reference, input]),
  );
  const observed = new Map<string, { bytes: number; sha256?: string }>();
  for (const entry of fs.exportLazyEntries()) {
    observed.set(entry.url, { bytes: entry.size });
  }
  for (const entry of fs.exportLazyArchiveEntries()) {
    if (entry.materialized) {
      throw new ReadinessError("builder-failure", `final lazy tree ${entry.url} is materialized`);
    }
    const identity = entry.content ?? entry.integrity;
    if (identity === undefined) {
      throw new ReadinessError("builder-failure", `final lazy tree ${entry.url} lacks integrity`);
    }
    observed.set(entry.url, { bytes: identity.bytes, sha256: identity.sha256 });
  }
  for (const [reference, value] of observed) {
    if (reference.includes("-candidates/")) {
      throw new ReadinessError("candidate-reference", `final VFS retains ${reference}`);
    }
    const expected = expectedLazy.get(reference);
    if (
      expected === undefined || expected.bytes !== value.bytes ||
      (value.sha256 !== undefined && expected.sha256 !== value.sha256)
    ) {
      throw new ReadinessError("builder-failure", `final VFS lazy reference ${reference} is unbound`);
    }
  }
  if (observed.size !== expectedLazy.size) {
    throw new ReadinessError("builder-failure", "final VFS lazy inventory is incomplete");
  }
}

function validateCandidateBuilderReport(
  report: JsonObject,
  resolved: ResolvedVfsProductInputsV1,
): void {
  const output = report?.output;
  if (
    report?.schema !== 1 || report?.kind !== "kandelo-vfs-builder-report" ||
    report.capture?.complete !== true || !jsonEqual(report.capture.unreported_reads, []) ||
    report.resolved_inputs_sha256 !== digest(resolved) ||
    !jsonEqual(report.product, resolved.product) ||
    !jsonEqual(report.inputs, expectedBuilderInputs(resolved)) ||
    !jsonEqual(output?.abi, resolved.target_abi) ||
    output?.name !== resolved.product.output || output?.path !== resolved.product.output ||
    !Number.isSafeInteger(output?.bytes) || output.bytes <= 0 ||
    typeof output?.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(output.sha256)
  ) {
    throw new ReadinessError(
      "candidate-input-invalid",
      "candidate builder report differs from its exact resolved inputs",
    );
  }
}

function expectedBuilderInputs(resolved: ResolvedVfsProductInputsV1): JsonObject[] {
  return resolved.inputs.map((input) => ({
    bytes: input.bytes,
    ...(input.descriptor === undefined
      ? {}
      : { descriptor: { bytes: input.descriptor.bytes, sha256: input.descriptor.sha256 } }),
    id: input.id,
    kind: input.kind,
    placement: input.effective_materialization,
    role: input.role,
    sha256: input.sha256,
  }));
}

function validateEvidenceReceipt(receipt: JsonObject, request: PagesEvidenceRequestV1): void {
  validateProductEvidenceResult(receipt);
  const vfsSha256 = sha256(request.vfs);
  const expectedCandidate = {
    builder_report_sha256: digest(request.builder_report),
    manifest_digest: `sha256:${vfsSha256}`,
    vfs_layer_bytes: request.vfs.byteLength,
    vfs_layer_sha256: vfsSha256,
  };
  if (!jsonEqual(receipt.candidate_product, expectedCandidate)) {
    throw new Error("evidence receipt candidate_product differs from the protected request");
  }
  if (!jsonEqual(receipt.definition, {
    definition_sha256: request.definition_sha256,
    id: request.definition_id,
  })) {
    throw new Error("evidence receipt definition differs from the protected request");
  }
  if (receipt.host !== request.host) {
    throw new Error("evidence receipt host differs from the protected request");
  }
  if (!jsonEqual(receipt.product, {
    id: request.product.id,
    manifest_sha256: request.product.manifest_sha256,
  })) {
    throw new Error("evidence receipt product differs from the protected request");
  }
  if (receipt.runtime.bundle_sha256 !== request.runtime_bundle_sha256) {
    throw new Error(
      "evidence receipt runtime_bundle_sha256 differs from the protected request",
    );
  }
}

function validatedEvidenceDefinitions(
  registry: PagesReadinessInputV1["evidence_definitions"]["value"],
): Map<string, { host: EvidenceHostV1; definition_sha256: string }> {
  if (
    registry.schema !== 1 || registry.kind !== "kandelo-vfs-evidence-definitions" ||
    !Number.isSafeInteger(registry.version) || registry.version <= 0 ||
    !Array.isArray(registry.definitions)
  ) {
    throw new ReadinessError("registry-stale", "evidence definition registry has unsupported identity");
  }
  const result = new Map<string, { host: EvidenceHostV1; definition_sha256: string }>();
  for (const definition of registry.definitions) {
    if (
      typeof definition.id !== "string" || definition.id.length === 0 ||
      !new Set(["node", "browser"]).has(definition.host) ||
      typeof definition.definition_sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(definition.definition_sha256) ||
      result.has(definition.id)
    ) {
      throw new ReadinessError("registry-stale", "evidence definition registry is malformed");
    }
    result.set(definition.id, {
      definition_sha256: definition.definition_sha256,
      host: definition.host,
    });
  }
  return result;
}

function topologicalPagesOrder(
  ids: string[],
  catalog: Map<string, { manifest: JsonObject }>,
  selected: Set<string>,
  blockers: PagesBlockerV1[],
): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      blockers.push(blocker("manifest-stale", `Pages product dependency cycle includes ${id}`, id));
      return;
    }
    visiting.add(id);
    const entry = catalog.get(id);
    if (entry === undefined) {
      blockers.push(blocker("manifest-stale", `Pages registry product ${id} has no manifest`, id));
    } else {
      for (const dependency of productDependencies(entry.manifest)) {
        if (!selected.has(dependency)) {
          blockers.push(
            blocker(
              "unpromoted-dependency",
              `${id} depends on non-Pages product ${dependency}`,
              id,
            ),
          );
        } else {
          visit(dependency);
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
    result.push(id);
  };
  [...ids].sort(ordinal).forEach(visit);
  return result;
}

function productDependencies(manifest: JsonObject): string[] {
  const values = manifest?.composition?.product;
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value.id)).sort(ordinal);
}

function exactSiteFiles(
  declared: PagesFileIdentityV1[],
  products: PagesFileIdentityV1[],
): PagesFileIdentityV1[] {
  const result = new Map<string, PagesFileIdentityV1>();
  for (const value of [...declared, ...products]) {
    const prior = result.get(value.path);
    if (prior !== undefined && !jsonEqual(prior, value)) {
      throw new Error(`Pages site path ${value.path} has conflicting identities`);
    }
    result.set(value.path, value);
  }
  return [...result.values()].sort((left, right) => ordinal(left.path, right.path));
}

function productSitePath(
  product: Pick<PagesReadyProductV1, "id" | "vfs_sha256">,
  abi: number,
): string {
  return `products/${product.id}/sha256-${product.vfs_sha256}/${product.id}-${abi}.vfs.zst`;
}

function canonicalProductReference(
  abi: number,
  id: string,
  digestValue: string,
  byteCount: number,
): string {
  const path = productSitePath({ id, vfs_sha256: digestValue }, abi);
  return `${CANONICAL_PAGES_ORIGIN}${path}?sha256=${digestValue}&bytes=${byteCount}`;
}

function blocker(kind: string, detail: string, productId?: string): PagesBlockerV1 {
  return {
    detail: detail.slice(0, 4_096),
    guard_code: "pages_product_incomplete",
    kind,
    ...(productId === undefined ? {} : { product_id: productId }),
  };
}

function asReadinessError(error: unknown, fallback: string): ReadinessError {
  return error instanceof ReadinessError
    ? error
    : new ReadinessError(fallback, errorMessage(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sourceDigest(value: { source_bytes?: Uint8Array; value: unknown }): string {
  return value.source_bytes === undefined ? digest(value.value) : sha256(value.source_bytes);
}

function runtimeDevShellLock(runtime: JsonObject): string | undefined {
  if (typeof runtime.dev_shell_lock_sha256 === "string") {
    return runtime.dev_shell_lock_sha256;
  }
  if (!Array.isArray(runtime.inventory)) return undefined;
  const matches = runtime.inventory.filter((entry: JsonObject) => entry?.path === "flake.lock");
  return matches.length === 1 && typeof matches[0]?.sha256 === "string"
    ? matches[0].sha256
    : undefined;
}

function sortedUnique(values: string[], label: string): string[] {
  const result = [...values].sort(ordinal);
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
}

function containsCandidateNamespace(value: unknown): boolean {
  if (typeof value === "string") return value.includes("-candidates/");
  if (Array.isArray(value)) return value.some(containsCandidateNamespace);
  return value !== null && typeof value === "object" &&
    Object.values(value as Record<string, unknown>).some(containsCandidateNamespace);
}

function digest(value: unknown): string {
  return sha256(canonicalJsonBytes(value));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(Buffer.from(canonicalJsonBytes(right)));
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface AssembleOptionsV1 {
  activationMode: "legacy" | "observe" | "active";
  readiness: string;
  siteManifest: string;
  sourceTree: string;
  deploymentRoot: string;
  maxBytes: number;
}

function canonicalDocument<T>(path: string, label: string): { bytes: Uint8Array; value: T } {
  const bytes = new Uint8Array(readFileSync(path));
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  if (!Buffer.from(bytes).equals(Buffer.from(canonicalJsonBytes(value)))) {
    throw new Error(`${label} is not canonical JSON`);
  }
  return { bytes, value };
}

export function assemblePagesSite(options: AssembleOptionsV1): void {
  if (!new Set(["legacy", "observe", "active"]).has(options.activationMode)) {
    throw new Error("Pages activation mode is unsupported");
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error("Pages maximum byte count must be positive");
  }
  const readinessDocument = canonicalDocument<PagesReadinessRecordV1>(
    options.readiness,
    "Pages readiness record",
  );
  validateReadinessShape(readinessDocument.value);
  if (!readinessDocument.value.ready) return;

  const siteDocument = canonicalDocument<PagesSiteManifestV1>(
    options.siteManifest,
    "Pages site manifest",
  );
  validateSiteShape(siteDocument.value, readinessDocument.value, readinessDocument.bytes);
  const sourceRoot = exactDirectory(options.sourceTree, "Pages source tree");
  const deploymentRoot = exactDirectory(options.deploymentRoot, "Pages deployment root");
  const sourceInventory = inventoryTree(sourceRoot, options.maxBytes);
  const files = new Map(sourceInventory);
  const deploymentManifestPath = ".well-known/kandelo/pages-deployment.json";
  const deploymentManifest = files.get(deploymentManifestPath);
  if (
    deploymentManifest === undefined ||
    deploymentManifest.sha256 !== sha256(siteDocument.bytes) ||
    deploymentManifest.bytes !== siteDocument.bytes.byteLength
  ) {
    throw new Error("Pages source tree lacks the exact deployment manifest");
  }
  files.delete(deploymentManifestPath);
  const expectedFiles = new Map(
    siteDocument.value.files.map((file) => [file.path, file]),
  );
  if (files.size !== expectedFiles.size) {
    throw new Error("Pages source tree differs from the exact site inventory");
  }
  for (const [path, actual] of files) {
    const expected = expectedFiles.get(path);
    if (expected === undefined || !jsonEqual(expected, actual)) {
      throw new Error(`Pages source file ${path} differs from its manifest identity`);
    }
  }

  const sitesRoot = join(deploymentRoot, "sites");
  mkdirSync(sitesRoot, { recursive: true, mode: 0o755 });
  exactDirectory(sitesRoot, "Pages sites root");
  const manifestSha = sha256(siteDocument.bytes);
  const siteName = `sha256-${manifestSha}`;
  const destination = join(sitesRoot, siteName);
  let staging: string | undefined;
  let pointerTemp: string | undefined;
  try {
    if (!existsSync(destination)) {
      staging = mkdtempSync(join(sitesRoot, `.${siteName}.staging-`));
      cpSync(sourceRoot, staging, {
        dereference: false,
        errorOnExist: true,
        filter: (source) => {
          if (lstatSync(source).isSymbolicLink()) {
            throw new Error("Pages source tree contains a symbolic link");
          }
          return true;
        },
        force: false,
        recursive: true,
      });
      const copied = inventoryTree(staging, options.maxBytes);
      if (!inventoryEqual(copied, sourceInventory)) {
        throw new Error("copied Pages sibling differs from the validated source tree");
      }
      renameSync(staging, destination);
      staging = undefined;
    } else {
      exactDirectory(destination, "existing content-addressed Pages site");
      if (!inventoryEqual(inventoryTree(destination, options.maxBytes), sourceInventory)) {
        throw new Error("existing content-addressed Pages site has different bytes");
      }
    }
    if (options.activationMode !== "active") return;
    const selection = canonicalJsonBytes({
      kind: "kandelo-pages-site-selection",
      path: `sites/${siteName}`,
      schema: 1,
      site_manifest_sha256: manifestSha,
    });
    pointerTemp = join(
      deploymentRoot,
      `.current-site.json.${process.pid}.${createHash("sha256").update(selection).digest("hex").slice(0, 16)}.tmp`,
    );
    writeFileSync(pointerTemp, selection, { flag: "wx", mode: 0o644 });
    renameSync(pointerTemp, join(deploymentRoot, "current-site.json"));
    pointerTemp = undefined;
  } finally {
    if (staging !== undefined && basename(staging).startsWith(`.${siteName}.staging-`)) {
      rmSync(staging, { force: true, recursive: true });
    }
    if (pointerTemp !== undefined && basename(pointerTemp).startsWith(".current-site.json.")) {
      rmSync(pointerTemp, { force: true });
    }
  }
}

function validateReadinessShape(readiness: PagesReadinessRecordV1): void {
  if (readiness.schema !== 1 || readiness.kind !== "kandelo-pages-readiness") {
    throw new Error("Pages readiness has unsupported identity");
  }
  if (containsCandidateNamespace(readiness)) {
    throw new Error("Pages readiness contains the candidate namespace");
  }
  if (!("site_metadata_sha256" in readiness)) {
    throw new Error("Pages readiness lacks an explicit site identity");
  }
  if (readiness.ready) {
    if (
      typeof readiness.site_metadata_sha256 !== "string" ||
      !SHA256.test(readiness.site_metadata_sha256)
    ) {
      throw new Error("ready Pages readiness requires a SHA-256 site identity");
    }
    if (readiness.blockers.length !== 0) throw new Error("ready Pages record contains blockers");
    const expected = [...readiness.pages_registry.products].sort((a, b) => ordinal(a.id, b.id));
    const actual = readiness.products.map(({ id, load }) => ({ id, load }));
    if (!jsonEqual(actual, expected)) throw new Error("ready Pages record lacks the complete product set");
  } else {
    if (readiness.site_metadata_sha256 !== null) {
      throw new Error("held Pages readiness requires a null site identity");
    }
    if (readiness.blockers.length === 0) {
      throw new Error("held Pages readiness lacks a blocker");
    }
  }
}

function validateSiteShape(
  site: PagesSiteManifestV1,
  readiness: PagesReadinessRecordV1,
  readinessBytes: Uint8Array,
): void {
  if (site.schema !== 1 || site.kind !== "kandelo-pages-site-manifest") {
    throw new Error("Pages site manifest has unsupported identity");
  }
  if (containsCandidateNamespace(site)) throw new Error("Pages site contains candidate namespace");
  if (
    site.readiness_record_sha256 !== sha256(readinessBytes) ||
    !jsonEqual(site.source, readiness.source) ||
    !jsonEqual(site.target_abi, readiness.target_abi) ||
    !jsonEqual(site.pages_registry, readiness.pages_registry) ||
    site.site_metadata_sha256 !== readiness.site_metadata_sha256
  ) {
    throw new Error("Pages site manifest differs from its exact readiness record");
  }
  const products = site.products.map(({ path: _path, ...product }) => product);
  if (!jsonEqual(products, readiness.products)) {
    throw new Error("Pages site products differ from readiness");
  }
  const paths = site.files.map(({ path }) => path);
  if (new Set(paths).size !== paths.length || !jsonEqual(paths, [...paths].sort(ordinal))) {
    throw new Error("Pages site files are not sorted and unique");
  }
  const files = new Map(site.files.map((file) => [file.path, file]));
  for (const build of Object.values(site.builds)) {
    if (!jsonEqual(files.get(build.path), build)) {
      throw new Error("Pages build identity is absent from the file inventory");
    }
  }
  for (const product of site.products) {
    if (
      !product.path.includes(`sha256-${product.vfs_sha256}`) ||
      !jsonEqual(files.get(product.path), {
        bytes: product.vfs_bytes,
        path: product.path,
        sha256: product.vfs_sha256,
      })
    ) {
      throw new Error(`Pages product ${product.id} is absent from the exact file inventory`);
    }
  }
}

function exactDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  const metadata = lstatSync(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} is not a real directory`);
  }
  return absolute;
}

function inventoryTree(root: string, maxBytes: number): Map<string, PagesFileIdentityV1> {
  const result = new Map<string, PagesFileIdentityV1>();
  let total = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 64) throw new Error("Pages tree exceeds its directory depth bound");
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => ordinal(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Pages tree contains a symbolic link");
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error("Pages tree contains a non-regular entry");
      const metadata = lstatSync(path);
      if (
        !metadata.isFile() || metadata.isSymbolicLink() ||
        !Number.isSafeInteger(metadata.size) || metadata.size < 0 ||
        result.size >= 65_536 || total + metadata.size > maxBytes
      ) {
        throw new Error("Pages tree exceeds its file or byte bound");
      }
      const bytes = new Uint8Array(readFileSync(path));
      if (bytes.byteLength !== metadata.size) {
        throw new Error("Pages tree changed while it was inventoried");
      }
      total += bytes.byteLength;
      const relativePath = relative(root, path).split(sep).join("/");
      result.set(relativePath, {
        bytes: bytes.byteLength,
        path: relativePath,
        sha256: sha256(bytes),
      });
    }
  };
  visit(root, 0);
  return result;
}

function inventoryEqual(
  left: Map<string, PagesFileIdentityV1>,
  right: Map<string, PagesFileIdentityV1>,
): boolean {
  return jsonEqual([...left.values()], [...right.values()]);
}

function cli(argv: string[]): void {
  const [action, ...rest] = argv;
  if (action !== "assemble-site") {
    throw new Error("usage: abi-staging-pages-readiness.ts assemble-site --activation PATH --readiness PATH --site-manifest PATH --source-tree PATH --deployment-root PATH --max-bytes N");
  }
  const flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!name?.startsWith("--") || value === undefined || flags.has(name)) {
      throw new Error("assemble-site arguments must be unique flag/value pairs");
    }
    flags.set(name, value);
  }
  const required = (name: string): string => {
    const value = flags.get(name);
    if (value === undefined) throw new Error(`assemble-site requires ${name}`);
    return value;
  };
  if (flags.size !== 6) throw new Error("assemble-site received an unknown flag");
  assemblePagesSite({
    activationMode: readPagesActivationMode(required("--activation")),
    deploymentRoot: required("--deployment-root"),
    maxBytes: Number(required("--max-bytes")),
    readiness: required("--readiness"),
    siteManifest: required("--site-manifest"),
    sourceTree: required("--source-tree"),
  });
}

function readPagesActivationMode(path: string): "legacy" | "observe" | "active" {
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024) {
    throw new Error("Pages activation document is empty or exceeds 64 KiB");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const match = text.match(
    /^schema = 1\nkind = "kandelo-pages-activation"\nmode = "(legacy|observe|active)"\n$/u,
  );
  if (match === null) throw new Error("Pages activation document is not the exact reviewed form");
  return match[1] as "legacy" | "observe" | "active";
}

const invoked = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(`abi-staging-pages-readiness: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
