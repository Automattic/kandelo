import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MemoryFileSystem } from "../host/src/vfs/memory-fs.ts";
import {
  canonicalJsonBytes,
  producePagesArtifacts,
  type PagesProducerTestDependenciesV1,
  type ProductionOciAuthority,
  type ProtectedPagesAuthoritiesV1,
} from "./abi-staging-pages-producer.ts";
import {
  type CanonicalProductBuildRequestV1,
  type PagesEvidenceRequestV1,
} from "./abi-staging-pages-readiness.ts";
import {
  evidenceDefinitionSha256,
  validateCandidateProductInputDocuments,
} from "./abi-staging-product-node-evidence.ts";

export type MiniaturePagesProducerScenario =
  | "ready"
  | "missing-product"
  | "missing-admission"
  | "builder-failure"
  | "evidence-failure"
  | "evidence-timeout"
  | "postflight-failure"
  | "sealed-product-mutation";

export interface MiniaturePagesProducerFixtureV1 {
  dependencies: PagesProducerTestDependenciesV1;
  handoffPath: string;
  oci: ProductionOciAuthority;
  outputRoot: string;
}

const source = {
  repository: "Automattic/kandelo",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
};
const targetAbi = { snapshot_sha256: "3".repeat(64), version: 18 };
const policySha256 = "4".repeat(64);
const lockSha256 = "5".repeat(64);

export async function createMiniaturePagesProducerFixture(
  root: string,
  scenario: MiniaturePagesProducerScenario,
): Promise<MiniaturePagesProducerFixtureV1> {
  const sourceRoot = join(root, "source");
  const runtimeRoot = join(root, "runtime");
  const siteRoot = join(root, "site");
  for (const path of [sourceRoot, runtimeRoot, join(siteRoot, "api"), join(siteRoot, "guide")]) {
    mkdirSync(path, { recursive: true });
  }
  writeFileSync(join(siteRoot, "index.html"), "browser\n");
  writeFileSync(join(siteRoot, "api/index.html"), "api\n");
  writeFileSync(join(siteRoot, "guide/index.html"), "guide\n");

  const runtimeBundle = {
    build_policy_sha256: policySha256,
    dev_shell_lock_sha256: lockSha256,
    source,
    target_abi: targetAbi,
  };
  const runtimeBundleBytes = canonicalJsonBytes(runtimeBundle);
  const runtimeBundlePath = join(root, "runtime-bundle.json");
  writeFileSync(runtimeBundlePath, runtimeBundleBytes);

  const baseManifest = {
    architecture: "wasm32",
    boot: { argv: ["/bin/sh"], cwd: "/", env: {}, gid: 0, uid: 0 },
    builder: "fixture-only",
    composition: {},
    id: "base",
    mounts: [{ path: "/", readonly: false, source: "built-image" }],
    output: "base.vfs.zst",
    schema: 1,
  };
  const childManifest = {
    ...baseManifest,
    composition: { product: [{ id: "base", materialization: "embedded" }] },
    id: "mini",
    output: "mini.vfs.zst",
  };
  const manifests = [baseManifest, childManifest].map((manifest) => ({
    manifest,
    path: `images/vfs/products/${manifest.id}.toml`,
    sha256: digest(canonicalJsonBytes(manifest)),
  }));
  const catalog = {
    kind: "kandelo-vfs-product-catalog",
    products: manifests,
    schema: 1,
  };
  const definitions = ["node", "browser"].map((host) => {
    const base = {
      host,
      id: `mini-${host}`,
      implementation: [],
      probe: {},
      runner: "exec",
      timeout_seconds: 30,
    };
    return { ...base, definition_sha256: evidenceDefinitionSha256(base as any) };
  });
  const evidenceDefinitions = {
    definitions,
    kind: "kandelo-vfs-evidence-definitions",
    schema: 1,
    version: 1,
  };
  const pages = {
    kind: "kandelo-pages-vfs-products",
    products: [{ id: "base", load: "eager" }, { id: "mini", load: "lazy" }],
    schema: 1,
  };
  const tests = {
    kind: "kandelo-test-vfs-products",
    registrations: ["base", "mini"].map((product) => ({
      applicability: { class: "required" },
      browser: ["mini-browser"],
      node: ["mini-node"],
      product,
    })),
    schema: 1,
  };
  const gallery = {
    kind: "kandelo-pages-vfs-product-gallery",
    products: [
      { gallery_entries: [], id: "base", vfs_image: "base" },
      { gallery_entries: ["shell"], id: "mini", vfs_image: "shell" },
    ],
    schema: 1,
  };
  const authorities: ProtectedPagesAuthoritiesV1 = {
    catalog: document("images/vfs/products/generated/catalog.json", catalog),
    definitions: document("abi/staging/evidence-definitions.generated.json", evidenceDefinitions),
    gallery,
    liveSetupSource:
      `const LIVE_DEMO_SPECS = {\n  shell: {\n    image: "shell",\n  },\n};\n`,
    pages: document(
      "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
      pages,
    ),
    presentationSource: `export const PRESET_LIBRARY = [\n    id: "shell",\n];\n`,
    tests: document("tests/vfs-products.generated.json", tests),
  };

  const candidates = new Map([
    ["base", candidateFixture(
      "base",
      manifests[0]!.sha256,
      runtimeBundleBytes,
      scenario === "missing-admission",
    )],
    ["mini", candidateFixture(
      "mini",
      manifests[1]!.sha256,
      runtimeBundleBytes,
      false,
      { dependency: "base" },
    )],
  ]);
  const mapPaths = ["archive-files.json", "package-roots.json"];
  for (const name of mapPaths) writeFileSync(join(root, name), canonicalJsonBytes({}));
  const programIndex = join(root, "program-index.json");
  writeFileSync(programIndex, canonicalJsonBytes({ kind: "fixture-program-index", schema: 1 }));
  const handoffPath = join(root, "handoff.json");
  const tapRoot = join(root, "tap-main");
  mkdirSync(tapRoot);
  writeFileSync(join(tapRoot, "README.md"), "exact fixture tap\n");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: tapRoot });
  execFileSync("git", ["config", "user.name", "Kandelo fixture"], { cwd: tapRoot });
  execFileSync("git", ["config", "user.email", "fixture@kandelo.invalid"], { cwd: tapRoot });
  execFileSync("git", ["add", "README.md"], { cwd: tapRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "exact fixture tap"], { cwd: tapRoot });
  execFileSync("git", [
    "remote", "add", "origin", "https://github.com/kandelo-dev/homebrew-tap-core.git",
  ], { cwd: tapRoot });
  const tapCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: tapRoot,
    encoding: "utf8",
  }).trim();
  const tapTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd: tapRoot,
    encoding: "utf8",
  }).trim();
  writeFileSync(handoffPath, canonicalJsonBytes({
    kind: "kandelo-pages-production-handoff",
    products: ["base", "mini"].map((id) => ({
      current_inputs: {
        archive_files: join(root, "archive-files.json"),
        package_roots: join(root, "package-roots.json"),
        program_index: programIndex,
      },
      id,
    })),
    run: {
      attempt: 1,
      repository: source.repository,
      run_id: 7,
      workflow_ref:
        "Automattic/kandelo/.github/workflows/abi-staging-pages-canary.yml@refs/heads/main",
    },
    runtime_bundle: runtimeBundlePath,
    runtime_root: runtimeRoot,
    schema: 1,
    site_source_root: siteRoot,
    source,
    source_root: sourceRoot,
    tap_root: tapRoot,
    tap_source: {
      commit: tapCommit,
      repository: "kandelo-dev/homebrew-tap-core",
      tree: tapTree,
    },
    target_abi: targetAbi,
  }));

  const runtimeEvidence = evidenceRuntimeIdentity(runtimeBundleBytes);
  const dependencies: PagesProducerTestDependenciesV1 = {
    afterPrepare(prepared) {
      if (scenario === "sealed-product-mutation") {
        writeFileSync(prepared.sealed_products[0]!.private_path, "mutated after preparation\n");
      }
    },
    async buildProduct(request) {
      if (scenario === "builder-failure") throw new Error("injected builder failure");
      for (const product of request.canonical_product_inputs) {
        const resolved = request.resolved_inputs.inputs.find(
          (input) => input.id === `product-${product.id}`,
        );
        if (
          resolved?.effective_materialization !== "embedded" ||
          resolved.sha256 !== product.sha256 || resolved.bytes !== product.bytes ||
          resolved.reference !== product.reference || digest(product.vfs) !== product.sha256
        ) throw new Error("fixture builder received a detached canonical product body");
      }
      const vfs = await buildFixtureVfs(request);
      return { builder_report: builderReport(request.resolved_inputs, vfs), vfs };
    },
    collectCurrentInputs(options) {
      const candidate = candidates.get(options.productId)!;
      const objects = candidate.resolved.inputs.flatMap((input: any) => {
        if (input.kind === "homebrew-bottle" || input.kind === "product-image") return [];
        const body = candidate.currentBodies.get(input.id)!;
        const relativePath = `inputs/objects/${input.id}`;
        mkdirSync(join(options.outRoot, "inputs/objects"), { recursive: true });
        writeFileSync(join(options.outRoot, relativePath), body);
        const { descriptor: _descriptor, effective_materialization: _placement,
          reference: _reference, ...object } = input;
        return [{ ...object, adapter: "fixture-current-input-v1", path: relativePath }];
      });
      return {
        build_environment: candidate.resolved.build_environment,
        kind: "kandelo-vfs-product-input-object-inventory",
        objects,
        product: {
          architecture: "wasm32",
          id: options.productId,
          manifest_path: `images/vfs/products/${options.productId}.toml`,
          manifest_sha256: manifests.find(({ manifest }) =>
            manifest.id === options.productId)!.sha256,
        },
        schema: 1,
        source,
        target_abi: targetAbi,
      };
    },
    createSourceReobserver() {
      return () => {
        if (scenario === "postflight-failure") {
          throw new Error("injected final source re-observation failure");
        }
      };
    },
    loadProtectedAuthorities() {
      return authorities;
    },
    observeRuntime() {
      return { devShellLockSha256: lockSha256, source, targetAbi };
    },
    async runEvidence(request) {
      validateFinalInputDocuments(request, catalog, runtimeEvidence);
      const outcome = scenario === "evidence-failure"
        ? "failure"
        : scenario === "evidence-timeout"
        ? "timeout"
        : "success";
      return evidenceReceipt(request, runtimeEvidence, outcome);
    },
    async validateAdmissionRecord() {},
    validateRegistries() {},
  };

  const oci: ProductionOciAuthority = {
    async fetchBlob(_repository, blobDigest, bytes) {
      const body = [...candidates.values()].map(({ blobs }) => blobs.get(blobDigest))
        .find((value) => value !== undefined);
      if (body === undefined || body.byteLength !== bytes) {
        throw new Error(`unexpected fixture OCI blob ${blobDigest}`);
      }
      return body;
    },
    async fetchCanonicalOci() { throw new Error("fixture has no admitted canonical layer"); },
    async fetchManifest(reference) {
      const candidate = [...candidates.values()].find((value) => value.reference === reference);
      if (candidate === undefined) throw new Error("unexpected fixture OCI manifest");
      return candidate.manifest;
    },
    async listImmutableReferences(repository) {
      if (repository.includes("/admissions")) return [];
      const productId = repository.split("/").at(-1)!;
      if (scenario === "missing-product" && productId === "mini") return [];
      const candidate = candidates.get(productId);
      return candidate === undefined ? [] : [candidate.reference];
    },
    async readAdmissionRecord() { throw new Error("fixture admission is unavailable"); },
  };
  return {
    dependencies,
    handoffPath,
    oci,
    outputRoot: join(root, "output"),
  };
}

function candidateFixture(
  productId: string,
  manifestSha256: string,
  runtimeBundleBytes: Uint8Array,
  homebrew: boolean,
  options: { dependency?: string } = {},
) {
  const repository =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-18-candidates/products/${productId}`;
  const embedded = new TextEncoder().encode("embedded current package\n");
  const lazy = new TextEncoder().encode("lazy current package\n");
  const metadata = canonicalJsonBytes({ formula: "dash" });
  const inputs = options.dependency !== undefined
    ? [{
      architecture: "wasm32",
      bytes: 99,
      declared_materialization: "embedded",
      effective_materialization: "embedded",
      id: `product-${options.dependency}`,
      kind: "product-image",
      path: `inputs/objects/product-${options.dependency}`,
      reference:
        `ghcr.io/kandelo-dev/homebrew-tap-core-abi-18-candidates/products/` +
        `${options.dependency}@sha256:${"7".repeat(64)}`,
      role: "runtime",
      sha256: "7".repeat(64),
    }]
    : homebrew
    ? [{
      architecture: "wasm32",
      bytes: lazy.byteLength,
      declared_materialization: "lazy",
      descriptor: {
        bytes: metadata.byteLength,
        path: "inputs/descriptors/homebrew-dash.json",
        reference: `${repository}@sha256:${digest(metadata)}`,
        sha256: digest(metadata),
      },
      effective_materialization: "lazy-reference",
      id: "homebrew-dash",
      kind: "homebrew-bottle",
      reference: `${repository}@sha256:${digest(lazy)}`,
      role: "runtime",
      sha256: digest(lazy),
    }, embeddedInput(embedded, repository)]
    : [embeddedInput(embedded, repository), {
      architecture: "wasm32",
      bytes: lazy.byteLength,
      declared_materialization: "lazy",
      effective_materialization: "lazy-reference",
      id: "package-lazy-output-runtime",
      kind: "package-output",
      reference: `${repository}@sha256:${digest(lazy)}`,
      role: "runtime",
      sha256: digest(lazy),
    }];
  const product = {
    architecture: "wasm32",
    id: productId,
    manifest_path: `images/vfs/products/${productId}.toml`,
    manifest_sha256: manifestSha256,
    output: `${productId}.vfs.zst`,
  };
  const resolved = {
    build_environment: {
      dev_shell_lock_sha256: lockSha256,
      policy_sha256: policySha256,
    },
    inputs,
    kind: "kandelo-resolved-vfs-product-inputs",
    product,
    reference_class: "candidate",
    schema: 1,
    source,
    target_abi: targetAbi,
  };
  const candidateVfsSha256 = "8".repeat(64);
  const report = builderReport(resolved, undefined, candidateVfsSha256, 99);
  const reportBytes = canonicalJsonBytes(report);
  const resolvedBytes = canonicalJsonBytes(resolved);
  const lazyArtifacts = homebrew || options.dependency !== undefined ? [] : [{
    bytes: lazy.byteLength,
    id: "package-lazy-output-runtime",
    immutable_reference: `${repository}@sha256:${digest(lazy)}`,
    kind: "package-output",
    sha256: digest(lazy),
  }];
  const artifact = (body: Uint8Array) => ({
    bytes: body.byteLength,
    immutable_reference: `${repository}@sha256:${digest(body)}`,
    sha256: digest(body),
  });
  const record = {
    artifacts: {
      builder_report: artifact(reportBytes),
      lazy_inputs: lazyArtifacts,
      resolved_inputs: artifact(resolvedBytes),
      runtime_bundle: artifact(runtimeBundleBytes),
      vfs_image: {
        bytes: 99,
        immutable_reference: `${repository}@sha256:${candidateVfsSha256}`,
        sha256: candidateVfsSha256,
      },
    },
    kind: "kandelo-vfs-candidate-product",
    nonendorsed: true,
    product,
    reference_class: "candidate",
    schema: 1,
    source,
    target_abi: targetAbi,
  };
  const config = canonicalJsonBytes(record);
  const descriptors = [
    ociDescriptor("candidate-product-record", "candidate-product-record.json",
      "application/vnd.kandelo.abi-staging.product.candidate.v1+json", config),
    {
      annotations: {
        "dev.kandelo.abi-staging.role": "vfs-image",
        "org.opencontainers.image.title": `${productId}.vfs.zst`,
      },
      digest: `sha256:${candidateVfsSha256}`,
      mediaType: "application/vnd.kandelo.vfs.image.v1",
      size: 99,
    },
    ociDescriptor("builder-report", "builder-report.json",
      "application/vnd.kandelo.vfs.builder-report.v1+json", reportBytes),
    ociDescriptor("resolved-inputs", "resolved-inputs.json",
      "application/vnd.kandelo.vfs.resolved-inputs.v1+json", resolvedBytes),
    ociDescriptor("runtime-bundle", "runtime-bundle.json",
      "application/vnd.kandelo.abi-staging.runtime-bundle.v1+json", runtimeBundleBytes),
    ...(!homebrew && options.dependency === undefined
      ? [ociDescriptor("lazy-input-0000", "lazy-input-package-lazy-output-runtime",
        "application/vnd.kandelo.vfs.lazy-input.v1", lazy)]
      : []),
  ];
  const manifest = canonicalJsonBytes({
    annotations: {
      "dev.kandelo.abi-staging.architecture": "wasm32",
      "dev.kandelo.abi-staging.classification": "public-candidate-not-endorsed",
      "dev.kandelo.abi-staging.kind": "candidate-product",
      "dev.kandelo.abi-staging.nonendorsed": "true",
      "dev.kandelo.abi-staging.product": productId,
      "dev.kandelo.abi-staging.target-abi": "18",
      "org.opencontainers.image.source": "https://github.com/Automattic/kandelo",
    },
    artifactType: "application/vnd.kandelo.abi-staging.product.candidate.v1+json",
    config: descriptors[0],
    layers: descriptors.slice(1),
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  const blobs = new Map<string, Uint8Array>([
    [`sha256:${digest(config)}`, config],
    [`sha256:${digest(reportBytes)}`, reportBytes],
    [`sha256:${digest(resolvedBytes)}`, resolvedBytes],
    [`sha256:${digest(runtimeBundleBytes)}`, runtimeBundleBytes],
    [`sha256:${digest(lazy)}`, lazy],
  ]);
  return {
    blobs,
    currentBodies: new Map([
      ["package-embedded-output-runtime", embedded],
      ["package-lazy-output-runtime", lazy],
    ]),
    manifest,
    reference: `${repository}@sha256:${digest(manifest)}`,
    resolved,
  };
}

function embeddedInput(body: Uint8Array, repository: string) {
  return {
    architecture: "wasm32",
    bytes: body.byteLength,
    declared_materialization: "embedded",
    effective_materialization: "embedded",
    id: "package-embedded-output-runtime",
    kind: "package-output",
    path: "inputs/objects/package-embedded-output-runtime",
    reference: `${repository}@sha256:${digest(body)}`,
    role: "runtime",
    sha256: digest(body),
  };
}

async function buildFixtureVfs(request: CanonicalProductBuildRequestV1): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  fs.mkdir("/usr", 0o755);
  fs.mkdir("/usr/bin", 0o755);
  writeMemoryFile(fs, "/usr/bin/ready", new TextEncoder().encode("ready\n"));
  for (const input of request.resolved_inputs.inputs) {
    if (input.effective_materialization === "lazy-reference") {
      fs.registerLazyFile(`/usr/bin/${input.id}`, input.reference!, input.bytes, 0o755);
    }
  }
  return fs.saveImage({
    metadata: {
      abiSnapshotSha256: targetAbi.snapshot_sha256,
      kernelAbi: targetAbi.version,
      version: 1,
    },
    normalizeTimestampsMs: 0,
  });
}

function writeMemoryFile(fs: MemoryFileSystem, path: string, body: Uint8Array): void {
  const fd = fs.open(path, 0x40 | 0x1 | 0x200, 0o755);
  fs.write(fd, body, 0, body.byteLength);
  fs.close(fd);
}

function builderReport(
  resolved: any,
  vfs?: Uint8Array,
  outputSha256 = vfs === undefined ? "8".repeat(64) : digest(vfs),
  outputBytes = vfs?.byteLength ?? 99,
) {
  return {
    capture: { complete: true, unreported_reads: [] },
    inputs: resolved.inputs.map((input: any) => ({
      bytes: input.bytes,
      ...(input.descriptor === undefined ? {} : { descriptor: {
        bytes: input.descriptor.bytes,
        sha256: input.descriptor.sha256,
      } }),
      id: input.id,
      kind: input.kind,
      placement: input.effective_materialization,
      role: input.role,
      sha256: input.sha256,
    })),
    kind: "kandelo-vfs-builder-report",
    output: {
      abi: targetAbi,
      bytes: outputBytes,
      name: resolved.product.output,
      path: resolved.product.output,
      sha256: outputSha256,
    },
    product: resolved.product,
    resolved_inputs_sha256: digest(canonicalJsonBytes(resolved)),
    schema: 1,
  };
}

function validateFinalInputDocuments(request: PagesEvidenceRequestV1, catalog: any, runtime: any) {
  const vfsSha256 = digest(request.vfs);
  const reportBytes = canonicalJsonBytes(request.builder_report);
  const productId = request.product.id;
  const locator = {
    builder_report_sha256: digest(reportBytes),
    immutable_reference:
      `https://automattic.github.io/kandelo/products/${productId}/sha256-${vfsSha256}/` +
      `${productId}-18.vfs.zst?sha256=${vfsSha256}&bytes=${request.vfs.byteLength}`,
    manifest_digest: `sha256:${vfsSha256}`,
    product_id: productId,
    reference_class: "canonical" as const,
    repository: `https://automattic.github.io/kandelo/products/${productId}`,
    vfs_layer_bytes: request.vfs.byteLength,
    vfs_layer_sha256: vfsSha256,
  };
  validateCandidateProductInputDocuments({
    boot: request.product.manifest.boot,
    candidate_product: {
      builder_report_sha256: locator.builder_report_sha256,
      manifest_digest: locator.manifest_digest,
      vfs_layer_bytes: locator.vfs_layer_bytes,
      vfs_layer_sha256: locator.vfs_layer_sha256,
    },
    definition: {
      definition_sha256: request.definition_sha256,
      host: request.host,
      id: request.definition_id,
      implementation: [],
      probe: {},
      runner: "exec",
      timeout_seconds: 30,
    } as any,
    mounts: request.product.manifest.mounts,
    product: { id: productId, manifest_sha256: request.product.manifest_sha256 },
    runtime,
  }, locator, catalog as any, lockSha256,
  canonicalJsonBytes(request.resolved_inputs), reportBytes);
}

function evidenceReceipt(
  request: PagesEvidenceRequestV1,
  runtime: any,
  outcome: "success" | "failure" | "timeout",
) {
  const vfsSha256 = digest(request.vfs);
  const reportSha256 = digest(canonicalJsonBytes(request.builder_report));
  return {
    bounded_diagnostics: [],
    candidate_product: {
      builder_report_sha256: reportSha256,
      manifest_digest: `sha256:${vfsSha256}`,
      vfs_layer_bytes: request.vfs.byteLength,
      vfs_layer_sha256: vfsSha256,
    },
    definition: {
      definition_sha256: request.definition_sha256,
      id: request.definition_id,
    },
    guard_codes: outcome === "success" ? [] : [
      outcome === "timeout" ? "verification_timeout" : "verification_failed",
    ],
    host: request.host,
    kind: "kandelo-vfs-product-evidence-result",
    outcome,
    product: { id: request.product.id, manifest_sha256: request.product.manifest_sha256 },
    request_digest: digest(canonicalJsonBytes({
      builder_report_sha256: reportSha256,
      definition_sha256: request.definition_sha256,
      host: request.host,
      product_id: request.product.id,
      runtime_bundle_sha256: request.runtime_bundle_sha256,
      vfs_sha256: vfsSha256,
    })),
    run: {
      attempt: 1,
      job_id: `fixture-${request.host}`,
      repository: source.repository,
      run_id: 7,
      workflow_ref:
        "Automattic/kandelo/.github/workflows/abi-staging-pages-canary.yml@refs/heads/main",
    },
    runtime,
    schema: 1,
  };
}

function evidenceRuntimeIdentity(runtimeBundleBytes: Uint8Array) {
  const kernelSha256 = "6".repeat(64);
  return {
    browser: {
      bundle_sha256: "7".repeat(64), bytes: 1,
      harness_entry_bytes: 1,
      harness_entry_path: "browser/dist/abi-staging-harness/index.html",
      harness_entry_sha256: "8".repeat(64), host_entry_bytes: 1,
      host_entry_path: "browser/dist/abi-staging/browser-host.js",
      host_entry_sha256: "9".repeat(64),
      kernel_asset_path: "browser/dist/assets/kernel.wasm",
      kernel_asset_sha256: kernelSha256,
      service_worker_sha256: "a".repeat(64),
    },
    build_policy_sha256: policySha256,
    bundle_sha256: digest(runtimeBundleBytes),
    host_runtime: {
      bundle_sha256: "b".repeat(64), bytes: 1,
      generated_abi_sha256: "c".repeat(64), worker_protocol_sha256: "d".repeat(64),
    },
    kernel: {
      abi_version: targetAbi.version, bytes: 1,
      snapshot_sha256: targetAbi.snapshot_sha256, wasm_sha256: kernelSha256,
    },
    source,
    target_abi: targetAbi,
  };
}

function document(path: string, value: any) {
  const bytes = canonicalJsonBytes(value);
  return { bytes, path, source_bytes: bytes, value };
}

function ociDescriptor(role: string, title: string, mediaType: string, body: Uint8Array) {
  return {
    annotations: {
      "dev.kandelo.abi-staging.role": role,
      "org.opencontainers.image.title": title,
    },
    digest: `sha256:${digest(body)}`,
    mediaType,
    size: body.byteLength,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [action, root, scenario] = process.argv.slice(2);
  if (
    action !== "produce" || root === undefined ||
    ![
      "ready", "missing-product", "missing-admission", "builder-failure",
      "evidence-failure", "evidence-timeout", "postflight-failure",
    ].includes(scenario ?? "")
  ) {
    throw new Error(
      "usage: abi-staging-pages-producer-fixture.ts produce ROOT SCENARIO",
    );
  }
  const fixture = await createMiniaturePagesProducerFixture(
    root,
    scenario as MiniaturePagesProducerScenario,
  );
  await producePagesArtifacts(
    fixture.handoffPath,
    fixture.outputRoot,
    fixture.oci,
    fixture.dependencies,
  );
}
