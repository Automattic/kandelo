import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MemoryFileSystem } from "../host/src/vfs/memory-fs.ts";
import {
  assemblePagesSite,
  canonicalJsonBytes,
  canonicalPagesInputReference,
  computePagesReadiness,
  finalizePagesReadiness,
  preparePagesProducts,
  recomposeCanonicalResolvedInputs,
  type CanonicalProductBuildRequestV1,
  type PagesEvidenceRequestV1,
  type PagesReadinessDependencies,
  type PagesReadinessInputV1,
} from "./abi-staging-pages-readiness.ts";

const SOURCE_ABI = 17;
const TARGET_ABI = SOURCE_ABI + 1;
const SOURCE = {
  repository: "Automattic/kandelo",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
};
const SNAPSHOT = "3".repeat(64);
const POLICY = "4".repeat(64);
const DEV_SHELL_LOCK = "5".repeat(64);

test("prepares all seven products once before final-site readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-prepared-seven-"));
  try {
    const input = sevenProductFixture();
    const inner = successfulDependencies();
    let builds = 0;
    let evidenceRuns = 0;
    const prepared = await preparePagesProducts(input, {
      ...inner,
      private_product_root: root,
      async buildProduct(request) {
        builds += 1;
        return inner.buildProduct(request);
      },
      async runEvidence(request) {
        evidenceRuns += 1;
        return inner.runEvidence(request);
      },
    });

    assert.deepEqual(
      prepared.sealed_products.map(({ id }) => id),
      [
        "mini-base",
        "mini-editor",
        "mini-files",
        "mini-network",
        "mini-shell",
        "mini-tools",
        "mini-workspace",
      ],
    );
    assert.equal(builds, 7);
    assert.equal(evidenceRuns, 14);
    assert.equal(finalizePagesReadiness(input, prepared, input.site_metadata).readiness.ready, true);
    assert.equal(finalizePagesReadiness(input, prepared, input.site_metadata).readiness.ready, true);
    assert.equal(builds, 7);
    assert.equal(evidenceRuns, 14);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("finalization authenticates the private sealed product bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-prepared-tamper-"));
  try {
    const input = fixture();
    const prepared = await preparePagesProducts(input, {
      ...successfulDependencies(),
      private_product_root: root,
    });
    writeFileSync(prepared.sealed_products[0]!.private_path, "mutated after preparation\n");

    assert.throws(
      () => finalizePagesReadiness(input, prepared, input.site_metadata),
      /sealed product .* differs from its authenticated identity/iu,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("finalization authenticates sealed bytes before site-metadata holds", async (t) => {
  for (const mutation of ["invalid", "missing", "extra"] as const) {
    await t.test(mutation, async () => {
      const root = mkdtempSync(join(tmpdir(), `kandelo-pages-sealed-before-${mutation}-`));
      try {
        const input = fixture();
        const prepared = await preparePagesProducts(input, {
          ...successfulDependencies(),
          private_product_root: root,
        });
        if (mutation === "missing") {
          rmSync(prepared.sealed_products[0]!.private_path);
        } else {
          writeFileSync(
            prepared.sealed_products[0]!.private_path,
            `mutated before ${mutation} site metadata\n`,
          );
        }
        const siteMetadata = structuredClone(input.site_metadata) as any;
        if (mutation === "invalid") {
          delete siteMetadata.kind;
        } else if (mutation === "missing") {
          siteMetadata.products.pop();
        } else {
          siteMetadata.products.push({
            gallery_entries: [],
            id: "not-on-pages",
            vfs_image: "not-on-pages",
          });
        }

        assert.throws(
          () => finalizePagesReadiness(input, prepared, siteMetadata),
          /sealed product .* differs from its authenticated identity/iu,
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
});

test("repeated finalization returns fresh nested artifact state", async (t) => {
  for (const nested of [
    "builder-report",
    "resolved-inputs",
    "node-receipts",
    "browser-receipts",
  ] as const) {
    await t.test(nested, async () => {
      const root = mkdtempSync(join(tmpdir(), `kandelo-pages-artifact-${nested}-`));
      try {
        const input = fixture();
        const prepared = await preparePagesProducts(input, {
          ...successfulDependencies(),
          private_product_root: root,
        });
        const first = finalizePagesReadiness(input, prepared, input.site_metadata);
        const pristine = structuredClone(first.artifacts);
        const artifact = first.artifacts![0]!;
        if (nested === "builder-report") {
          artifact.builder_report.output.sha256 = "0".repeat(64);
        } else if (nested === "resolved-inputs") {
          artifact.resolved_inputs.inputs[0]!.sha256 = "0".repeat(64);
        } else if (nested === "node-receipts") {
          artifact.node_receipts[0]!.outcome = "failure";
          artifact.node_receipts.push({ poisoned: true });
        } else {
          artifact.browser_receipts[0]!.outcome = "failure";
          artifact.browser_receipts.push({ poisoned: true });
        }

        const replay = finalizePagesReadiness(input, prepared, input.site_metadata);
        assert.deepEqual(replay.artifacts, pristine);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
});

test("finalization requires the exact sorted sealed product set", async (t) => {
  for (const mutation of ["missing", "extra", "reordered", "duplicate"] as const) {
    await t.test(mutation, async () => {
      const root = mkdtempSync(join(tmpdir(), `kandelo-pages-prepared-${mutation}-`));
      try {
        const input = fixture();
        const prepared = await preparePagesProducts(input, {
          ...successfulDependencies(),
          private_product_root: root,
        });
        if (mutation === "missing") {
          prepared.sealed_products.pop();
        } else if (mutation === "extra") {
          prepared.sealed_products.push({
            ...prepared.sealed_products[0]!,
            id: "not-on-pages",
          });
        } else if (mutation === "reordered") {
          prepared.sealed_products.reverse();
        } else {
          prepared.sealed_products[1] = { ...prepared.sealed_products[0]! };
        }

        assert.throws(
          () => finalizePagesReadiness(input, prepared, input.site_metadata),
          /sealed products must be the exact sorted Pages product set/iu,
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
});

test("finalization accepts only in-process preparation state", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-prepared-private-state-"));
  try {
    const input = fixture();
    const prepared = await preparePagesProducts(input, {
      ...successfulDependencies(),
      private_product_root: root,
    });
    assert.throws(
      () => finalizePagesReadiness(input, structuredClone(prepared), input.site_metadata),
      /not prepared by this process/iu,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("finalization rejects candidate strings and unsealed VFS paths", async (t) => {
  for (const mutation of ["candidate", "unsealed-vfs", "vite-hashed-vfs"] as const) {
    await t.test(mutation, async () => {
      const root = mkdtempSync(join(tmpdir(), `kandelo-pages-final-site-${mutation}-`));
      try {
        const input = fixture();
        const prepared = await preparePagesProducts(input, {
          ...successfulDependencies(),
          private_product_root: root,
        });
        const siteMetadata = structuredClone(input.site_metadata);
        if (mutation === "candidate") {
          siteMetadata.products[0]!.vfs_image = "products/-candidates/mini-base.vfs.zst";
        } else if (mutation === "unsealed-vfs") {
          siteMetadata.files = [
            siteMetadata.api,
            siteMetadata.browser,
            siteMetadata.documentation,
            artifact("legacy/mini-base.vfs.zst"),
          ];
        } else {
          siteMetadata.files = [
            siteMetadata.api,
            siteMetadata.browser,
            siteMetadata.documentation,
            artifact("assets/shell.vfs-BrtFEJTw.zst"),
          ];
        }
        assert.throws(
          () => finalizePagesReadiness(input, prepared, siteMetadata),
          mutation === "candidate" ? /candidate namespace/iu : /outside the sealed product set/iu,
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
});

test("a preparation hold has no identity for a site that was never finalized", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-prepared-hold-"));
  try {
    const input = fixture();
    input.products[0]!.admissions.pop();
    const prepared = await preparePagesProducts(input, {
      ...successfulDependencies(),
      private_product_root: root,
    });
    const malformedSiteMetadata = { candidate: "https://example.invalid/-candidates/site" };
    const result = finalizePagesReadiness(input, prepared, malformedSiteMetadata as any);

    assert.equal(result.readiness.ready, false);
    assert.equal(result.readiness.site_metadata_sha256, null);
    assert.equal(result.site_manifest, undefined);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("compatibility wrapper holds stale exact site metadata without preparing products", async () => {
  const input = fixture();
  input.site_metadata.api.sha256 = "0".repeat(64);
  const inner = successfulDependencies();
  let builds = 0;
  let evidenceRuns = 0;
  const result = await computePagesReadiness(input, {
    ...inner,
    async buildProduct(request) {
      builds += 1;
      return inner.buildProduct(request);
    },
    async runEvidence(request) {
      evidenceRuns += 1;
      return inner.runEvidence(request);
    },
  });

  assert.equal(result.readiness.ready, false);
  assert.equal(result.readiness.site_metadata_sha256, null);
  assert.deepEqual(result.readiness.blockers.map(({ kind }) => kind), ["site-metadata-stale"]);
  assert.equal(builds, 0);
  assert.equal(evidenceRuns, 0);
});

test("preparation rejects product IDs that can escape the private root", async () => {
  const parent = mkdtempSync(join(tmpdir(), "kandelo-pages-hostile-id-"));
  const privateRoot = join(parent, "sealed");
  mkdirSync(privateRoot);
  try {
    const input = hostileProductIdFixture();
    await assert.rejects(
      () => preparePagesProducts(input, {
        ...successfulDependencies(),
        private_product_root: privateRoot,
      }),
      /Pages product id.*stable/iu,
    );
    assert.equal(existsSync(join(parent, "escape.vfs.zst")), false);
  } finally {
    rmSync(parent, { force: true, recursive: true });
  }
});

test("assembly enforces exact ready and held site identity semantics", async (t) => {
  const ready = await computePagesReadiness(fixture(), successfulDependencies());
  const heldInput = fixture();
  heldInput.products[0]!.admissions.pop();
  const held = await computePagesReadiness(heldInput, successfulDependencies());
  for (const mutation of ["ready-null", "ready-invalid", "held-non-null", "held-missing"] as const) {
    await t.test(mutation, () => {
      const root = mkdtempSync(join(tmpdir(), `kandelo-pages-assembly-${mutation}-`));
      try {
        const readiness = structuredClone(
          mutation.startsWith("ready") ? ready.readiness : held.readiness,
        ) as any;
        if (mutation === "ready-null") {
          readiness.site_metadata_sha256 = null;
        } else if (mutation === "ready-invalid") {
          readiness.site_metadata_sha256 = "not-a-sha256";
        } else if (mutation === "held-non-null") {
          readiness.site_metadata_sha256 = "0".repeat(64);
        } else {
          delete readiness.site_metadata_sha256;
        }
        const readinessPath = join(root, "readiness.json");
        writeFileSync(readinessPath, canonicalJsonBytes(readiness));
        assert.throws(
          () => assemblePagesSite({
            activationMode: "legacy",
            deploymentRoot: join(root, "deployment"),
            maxBytes: 1_000_000,
            readiness: readinessPath,
            siteManifest: join(root, "site-manifest.json"),
            sourceTree: join(root, "source-tree"),
          }),
          /site identity/iu,
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
});

test("recomposes admitted layers without changing bytes or placement", () => {
  const input = fixture();
  const base = input.products.find((product) => product.id === "mini-base")!;
  const admissions = authenticatedAdmissions(base);
  const canonical = recomposeCanonicalResolvedInputs({
    admissions,
    candidateResolvedInputs: base.candidate_resolved_inputs,
    canonicalProducts: new Map(),
    currentResolvedInputs: base.current_resolved_inputs,
    targetAbi: input.target_abi,
  });
  const candidateInputs = base.candidate_resolved_inputs.inputs;

  assert.equal(canonical.reference_class, "canonical");
  assert.deepEqual(
    canonical.inputs.map(inputIdentity),
    candidateInputs.map(inputIdentity),
  );
  assert.equal(canonical.inputs[0]!.reference!.includes("-candidates/"), false);
  assert.equal(canonical.inputs[0]!.descriptor!.reference.includes("-candidates/"), false);
  assert.equal(
    canonical.inputs[0]!.descriptor!.reference,
    admissions[0]!.canonical_vfs_composition_descriptor.immutable_reference,
  );
  assert.equal(
    canonical.inputs[0]!.descriptor!.sha256,
    admissions[0]!.canonical_vfs_composition_descriptor.sha256,
  );
  assert.notEqual(
    canonical.inputs[0]!.descriptor!.sha256,
    candidateInputs[0]!.descriptor!.sha256,
  );
  assert.equal(canonical.inputs[1]!.reference!.includes("-candidates/"), false);
  assert.match(
    canonical.inputs[1]!.reference!,
    new RegExp(`homebrew-tap-core-abi-${TARGET_ABI}/tool@sha256:${canonical.inputs[1]!.sha256}$`),
  );
  assert.equal(
    JSON.stringify(canonical).includes("-candidates/"),
    false,
  );
});

test("requires the exact canonical VFS composition descriptor", () => {
  const input = fixture();
  const base = input.products.find((product) => product.id === "mini-base")!;
  const admissions = authenticatedAdmissions(base);
  delete (admissions[0] as any).canonical_vfs_composition_descriptor;

  assert.throws(
    () => recomposeCanonicalResolvedInputs({
      admissions,
      candidateResolvedInputs: base.candidate_resolved_inputs,
      canonicalProducts: new Map(),
      currentResolvedInputs: base.current_resolved_inputs,
      targetAbi: input.target_abi,
    }),
    /canonical VFS composition descriptor/u,
  );
});

test("rejects an admission that the authoritative record validator rejects", async () => {
  const input = fixture();
  const envelope = input.products[0]!.admissions[0]!;
  envelope.record.admission.canonical_public_readback_sha256 = "8".repeat(64);
  envelope.record_sha256 = digest(envelope.record);
  envelope.immutable_reference =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${TARGET_ABI}/base/admissions@sha256:${envelope.record_sha256}`;

  await assertBlocked(input, "admission-invalid", "mini-base");
});

test("derives canonical bottle metadata from the admitted public manifest", async () => {
  await assertBlocked(
    fixture(),
    "admission-invalid",
    "mini-base",
    successfulDependencies({ canonicalOciMutation: "metadata" }),
  );
});

test("keeps the authenticated admission manifest locator distinct from record bytes", async () => {
  const input = fixture();
  const envelope = input.products[0]!.admissions[0]!;
  const manifestSha256 = envelope.immutable_reference.split("@sha256:")[1];
  assert.notEqual(manifestSha256, envelope.record_sha256);
  const result = await computePagesReadiness(input, successfulDependencies());
  assert.equal(result.readiness.ready, true);
  assert.ok(result.readiness.products[0]!.admissions.some(
    ({ immutable_reference }) => immutable_reference === envelope.immutable_reference,
  ));
});

test("hands authenticated canonical bottle bytes to every final builder", async () => {
  const input = fixture();
  const inner = successfulDependencies();
  let observed = 0;
  const result = await computePagesReadiness(input, {
    ...inner,
    async buildProduct(request) {
      for (const layer of request.canonical_homebrew_layers) {
        const resolved = request.resolved_inputs.inputs.find(
          (candidate) => candidate.id === layer.input_id,
        )!;
        assert.equal(layer.bytes, resolved.bytes);
        assert.equal(layer.sha256, resolved.sha256);
        assert.equal(sha256(layer.body), resolved.sha256);
        observed += 1;
      }
      return inner.buildProduct(request);
    },
  });

  assert.equal(result.readiness.ready, true);
  assert.equal(observed, 2);
  await assertBlocked(
    fixture(),
    "admission-invalid",
    "mini-base",
    successfulDependencies({ canonicalOciMutation: "layer" }),
  );
});

test("builds from current-main recaptured material instead of candidate paths", async () => {
  const input = fixture();
  const base = input.products.find((product) => product.id === "mini-base")!;
  base.current_resolved_inputs = structuredClone(base.candidate_resolved_inputs);
  base.current_resolved_inputs.source = structuredClone(input.source);
  base.current_resolved_inputs.inputs[0]!.path = "current/objects/homebrew-base";
  base.current_resolved_inputs.inputs[0]!.descriptor!.path =
    "current/descriptors/homebrew-base.json";
  const inner = successfulDependencies();
  const result = await computePagesReadiness(input, {
    ...inner,
    async buildProduct(request) {
      if (request.product.id === "mini-base") {
        assert.equal(
          request.resolved_inputs.inputs[0]!.path,
          "current/objects/homebrew-base",
        );
        assert.equal(
          request.resolved_inputs.inputs[0]!.descriptor!.path,
          "current/descriptors/homebrew-base.json",
        );
      }
      return inner.buildProduct(request);
    },
  });

  assert.equal(result.readiness.ready, true);

  const changed = fixture();
  const changedBase = changed.products.find((product) => product.id === "mini-base")!;
  changedBase.current_resolved_inputs = structuredClone(
    changedBase.candidate_resolved_inputs,
  );
  changedBase.current_resolved_inputs.inputs[0]!.sha256 = "f".repeat(64);
  await assertBlocked(changed, "current-input-invalid", "mini-base");
});

test("requires current-main recapture for every Pages product", async () => {
  const input = fixture();
  delete (input.products[0] as any).current_resolved_inputs;

  await assertBlocked(input, "current-input-invalid", "mini-base");
});

test("keeps embedded recaptures path-only and publishes only lazy inputs", () => {
  const input = fixture();
  const product = input.products[0]!;
  const candidate = structuredClone(product.candidate_resolved_inputs);
  candidate.inputs = [
    {
      architecture: "wasm32",
      bytes: 11,
      declared_materialization: "embedded",
      effective_materialization: "embedded",
      id: "package-embedded-output-runtime",
      kind: "package-output",
      path: "candidate/embedded",
      reference: candidateReference("embedded", "a".repeat(64)),
      role: "runtime",
      sha256: "a".repeat(64),
    },
    {
      architecture: "wasm32",
      bytes: 12,
      declared_materialization: "lazy",
      effective_materialization: "lazy-reference",
      id: "package-lazy-output-runtime",
      kind: "package-output",
      reference: candidateReference("lazy", "b".repeat(64)),
      role: "runtime",
      sha256: "b".repeat(64),
    },
  ];
  const current = structuredClone(candidate);
  current.source = structuredClone(input.source);
  current.inputs[0]!.path = "current/embedded";
  delete current.inputs[0]!.reference;
  delete current.inputs[1]!.reference;
  const lazyReference = canonicalPagesInputReference(
    current.inputs[1]!.id,
    current.inputs[1]!.sha256,
    current.inputs[1]!.bytes,
  );

  const canonical = recomposeCanonicalResolvedInputs({
    admissions: [],
    candidateResolvedInputs: candidate,
    canonicalArtifacts: [{
      bytes: current.inputs[1]!.bytes,
      input_id: current.inputs[1]!.id,
      reference: lazyReference,
      sha256: current.inputs[1]!.sha256,
    }],
    canonicalProducts: new Map(),
    currentResolvedInputs: current,
    targetAbi: input.target_abi,
  });

  assert.equal(canonical.inputs[0]!.path, "current/embedded");
  assert.equal(canonical.inputs[0]!.reference, undefined);
  assert.equal(canonical.inputs[1]!.path, undefined);
  assert.equal(canonical.inputs[1]!.reference, lazyReference);
});

test("recomposes same-tree repository paths from their current commit bytes", () => {
  const input = fixture();
  const base = input.products.find((product) => product.id === "mini-base")!;
  const candidate = structuredClone(base.candidate_resolved_inputs);
  candidate.inputs = [{
    architecture: "wasm32",
    bytes: 101,
    declared_materialization: "embedded",
    effective_materialization: "embedded",
    id: "repository-rootfs-source",
    kind: "repository-path",
    path: "candidate/repository-rootfs-source",
    paths: ["MANIFEST", "images/rootfs"],
    reference:
      `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${TARGET_ABI}-candidates/` +
      `products/mini-base@sha256:${"a".repeat(64)}`,
    repository_id: "rootfs-source",
    role: "runtime",
    sha256: "a".repeat(64),
  }];
  const current = structuredClone(candidate);
  current.source = { ...candidate.source, commit: "9".repeat(40) };
  current.inputs[0]!.bytes = 102;
  current.inputs[0]!.sha256 = "b".repeat(64);
  current.inputs[0]!.path = "current/repository-rootfs-source";
  delete current.inputs[0]!.reference;
  const recomposed = recomposeCanonicalResolvedInputs({
    admissions: [],
    candidateResolvedInputs: candidate,
    canonicalProducts: new Map(),
    currentResolvedInputs: current,
    currentSource: current.source,
    targetAbi: input.target_abi,
  });
  assert.equal(recomposed.inputs[0]!.sha256, "b".repeat(64));
  assert.equal(recomposed.inputs[0]!.bytes, 102);
  assert.equal(recomposed.inputs[0]!.reference, undefined);
  assert.equal(recomposed.inputs[0]!.path, "current/repository-rootfs-source");
});

test("requires an exact canonical public layer for non-Formula lazy inputs", () => {
  const input = fixture();
  const base = input.products.find((product) => product.id === "mini-base")!;
  const admissions = authenticatedAdmissions(base);
  const packageInput = base.candidate_resolved_inputs.inputs[1]!;
  packageInput.id = "package-tool-output-tool";
  packageInput.kind = "package-output";
  base.current_resolved_inputs = structuredClone(base.candidate_resolved_inputs);
  delete base.current_resolved_inputs.inputs[1]!.reference;
  const reference = canonicalPagesInputReference(
    packageInput.id,
    packageInput.sha256,
    packageInput.bytes,
  );
  const descriptorReference = canonicalPagesInputReference(
    packageInput.id,
    packageInput.descriptor!.sha256,
    packageInput.descriptor!.bytes,
  );

  assert.throws(
    () => recomposeCanonicalResolvedInputs({
      admissions,
      candidateResolvedInputs: base.candidate_resolved_inputs,
      canonicalProducts: new Map(),
      currentResolvedInputs: base.current_resolved_inputs,
      targetAbi: input.target_abi,
    }),
    /exact canonical public layer/u,
  );

  const canonicalArtifacts = [{
    bytes: packageInput.bytes,
    input_id: packageInput.id,
    reference,
    sha256: packageInput.sha256,
    descriptor_reference: descriptorReference,
  }];
  const canonical = recomposeCanonicalResolvedInputs({
    admissions,
    candidateResolvedInputs: base.candidate_resolved_inputs,
    canonicalArtifacts,
    canonicalProducts: new Map(),
    currentResolvedInputs: base.current_resolved_inputs,
    targetAbi: input.target_abi,
  });
  assert.deepEqual(inputIdentity(canonical.inputs[1]!), inputIdentity(packageInput));
  assert.equal(canonical.inputs[1]!.reference, reference);
  assert.equal(canonical.inputs[1]!.descriptor!.reference, descriptorReference);

  canonicalArtifacts[0]!.reference = reference.replace(
    `bytes=${packageInput.bytes}`,
    `bytes=${packageInput.bytes + 1}`,
  );
  assert.throws(
    () => recomposeCanonicalResolvedInputs({
      admissions,
      candidateResolvedInputs: base.candidate_resolved_inputs,
      canonicalArtifacts,
      canonicalProducts: new Map(),
      currentResolvedInputs: base.current_resolved_inputs,
      targetAbi: input.target_abi,
    }),
    /exact canonical public layer/u,
  );

  canonicalArtifacts[0]!.reference = reference;
  canonicalArtifacts[0]!.descriptor_reference = descriptorReference.replace(
    `bytes=${packageInput.descriptor!.bytes}`,
    `bytes=${packageInput.descriptor!.bytes + 1}`,
  );
  assert.throws(
    () => recomposeCanonicalResolvedInputs({
      admissions,
      candidateResolvedInputs: base.candidate_resolved_inputs,
      canonicalArtifacts,
      canonicalProducts: new Map(),
      currentResolvedInputs: base.current_resolved_inputs,
      targetAbi: input.target_abi,
    }),
    /exact canonical public layer/u,
  );
});

test("requires every Pages-hosted lazy input in the complete site inventory", async () => {
  const input = fixture();
  const base = input.products.find((product) => product.id === "mini-base")!;
  const packageInput = base.candidate_resolved_inputs.inputs[1]!;
  packageInput.id = "package-tool-output-tool";
  packageInput.kind = "package-output";
  base.current_resolved_inputs = structuredClone(base.candidate_resolved_inputs);
  delete base.current_resolved_inputs.inputs[1]!.reference;
  const reference = canonicalPagesInputReference(
    packageInput.id,
    packageInput.sha256,
    packageInput.bytes,
  );
  const descriptorReference = canonicalPagesInputReference(
    packageInput.id,
    packageInput.descriptor!.sha256,
    packageInput.descriptor!.bytes,
  );
  base.admissions = base.admissions.filter(
    ({ record }) => record.admission.formula_metadata_update.formula === "base",
  );
  base.canonical_artifacts = [{
    bytes: packageInput.bytes,
    descriptor_reference: descriptorReference,
    input_id: packageInput.id,
    reference,
    sha256: packageInput.sha256,
  }];
  base.candidate_builder_report = builderReport(
    base.candidate_resolved_inputs,
    new TextEncoder().encode("candidate mini-base with package output\n"),
  );

  await assertBlocked(input, "site-input-missing", "mini-base");

  input.site_metadata.files = [
    input.site_metadata.api,
    input.site_metadata.browser,
    input.site_metadata.documentation,
    {
      bytes: packageInput.bytes,
      path: `products/inputs/${packageInput.id}/sha256-${packageInput.sha256}/${packageInput.id}`,
      sha256: packageInput.sha256,
    },
    {
      bytes: packageInput.descriptor!.bytes,
      path: `products/inputs/${packageInput.id}/sha256-${packageInput.descriptor!.sha256}/${packageInput.id}`,
      sha256: packageInput.descriptor!.sha256,
    },
  ];
  input.authority.site_metadata_sha256 = digest(input.site_metadata);
  const result = await computePagesReadiness(input, successfulDependencies());

  assert.equal(result.readiness.ready, true);
  assert.deepEqual(
    result.site_manifest!.files.filter(({ path }) => path.startsWith("products/inputs/")),
    input.site_metadata.files.slice(3).sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0
    ),
  );
});

test("produces the exact complete Pages product set", async () => {
  const input = fixture();
  const result = await computePagesReadiness(input, successfulDependencies());

  assert.equal(result.readiness.ready, true);
  assert.deepEqual(result.readiness.blockers, []);
  assert.deepEqual(
    result.readiness.products.map((product) => product.id),
    ["mini-base", "mini-shell"],
  );
  assert.deepEqual(
    result.site_manifest?.products.map((product) => product.id),
    ["mini-base", "mini-shell"],
  );
  assert.equal(result.readiness.source.commit, SOURCE.commit);
  assert.equal(result.readiness.target_abi.version, TARGET_ABI);
  assert.equal(
    JSON.stringify(result).includes("-candidates/"),
    false,
  );
  for (const product of result.readiness.products) {
    const candidate = input.products.find((value) => value.id === product.id)!;
    assert.notEqual(
      product.vfs_sha256,
      candidate.candidate_builder_report.output.sha256,
    );
  }
});

test("returns the exact final VFS, report, and evidence artifacts for site assembly", async () => {
  const result = await computePagesReadiness(fixture(), successfulDependencies());
  const artifacts = result.artifacts!;

  assert.deepEqual(
    artifacts.map((artifact) => artifact.id),
    ["mini-base", "mini-shell"],
  );
  for (const artifact of artifacts) {
    const ready = result.readiness.products.find((product) => product.id === artifact.id)!;
    assert.equal(sha256(artifact.vfs), ready.vfs_sha256);
    assert.equal(artifact.vfs.byteLength, ready.vfs_bytes);
    assert.equal(digest(artifact.builder_report), ready.builder_report_sha256);
    assert.equal(digest(artifact.resolved_inputs), ready.resolved_inputs_sha256);
    assert.deepEqual(
      artifact.node_receipts.map((receipt) => ({
        id: receipt.definition.id,
        sha256: digest(receipt),
      })),
      ready.node_receipts,
    );
    assert.deepEqual(
      artifact.browser_receipts.map((receipt) => ({
        id: receipt.definition.id,
        sha256: digest(receipt),
      })),
      ready.browser_receipts,
    );
  }
});

test("hands exact final product bytes to each dependent builder", async () => {
  const input = fixture();
  const inner = successfulDependencies();
  let checked = false;
  const dependencies: PagesReadinessDependencies = {
    async buildProduct(request) {
      if (request.product.id === "mini-shell") {
        const productInputs = request.canonical_product_inputs;
        assert.equal(productInputs.length, 1);
        const dependency = productInputs[0];
        const resolved = request.resolved_inputs.inputs.find(
          (value) => value.id === "product-mini-base",
        )!;
        assert.equal(dependency.id, "mini-base");
        assert.equal(dependency.sha256, resolved.sha256);
        assert.equal(dependency.bytes, resolved.bytes);
        assert.equal(sha256(dependency.vfs), resolved.sha256);
        assert.notEqual(
          dependency.sha256,
          input.products[0]!.candidate_builder_report.output.sha256,
        );
        const expectedPath =
          `products/mini-base/sha256-${dependency.sha256}/mini-base-${TARGET_ABI}.vfs.zst`;
        assert.equal(
          dependency.reference,
          `https://automattic.github.io/kandelo/${expectedPath}` +
            `?sha256=${dependency.sha256}&bytes=${dependency.bytes}`,
        );
        checked = true;
      }
      return inner.buildProduct(request);
    },
    runEvidence: (request) => inner.runEvidence(request),
    validateAdmissionRecord: (record) => inner.validateAdmissionRecord(record),
    fetchCanonicalOci: (reference) => inner.fetchCanonicalOci(reference),
  };

  const result = await computePagesReadiness(input, dependencies);
  assert.equal(result.readiness.ready, true);
  assert.equal(checked, true);
});

test("holds readiness when one exact admission is missing", async () => {
  const input = fixture();
  input.products[0].admissions.pop();
  await assertBlocked(input, "missing-admission", "mini-base");
});

test("accepts a merge commit only when the candidate plan has the exact current tree", async () => {
  const input = fixture();
  const candidateHead = "8".repeat(40);
  for (const product of input.products) {
    product.candidate_resolved_inputs.source = {
      ...SOURCE,
      commit: candidateHead,
    };
    product.candidate_builder_report = builderReport(
      product.candidate_resolved_inputs,
      new TextEncoder().encode(`${product.id} candidate VFS\n`),
    );
  }
  const inner = successfulDependencies();
  let observed = 0;
  const result = await computePagesReadiness(input, {
    ...inner,
    async buildProduct(request) {
      assert.deepEqual(request.resolved_inputs.source, SOURCE);
      observed += 1;
      return inner.buildProduct(request);
    },
  });

  assert.equal(result.readiness.ready, true);
  assert.equal(observed, input.pages_registry.value.products.length);
  for (const artifact of result.artifacts!) {
    assert.deepEqual(artifact.resolved_inputs.source, SOURCE);
  }
});

test("rejects candidate product inputs attributed to another exact source tree", async () => {
  const input = fixture();
  input.products[0]!.candidate_resolved_inputs.source = {
    ...SOURCE,
    tree: "8".repeat(40),
  };

  await assertBlocked(input, "candidate-input-invalid", "mini-base");
});

test("rejects candidate product inputs labeled as another protected manifest", async () => {
  const input = fixture();
  input.products[0]!.candidate_resolved_inputs.product = {
    ...input.products[0]!.candidate_resolved_inputs.product,
    manifest_sha256: "8".repeat(64),
  };

  await assertBlocked(input, "candidate-input-invalid", "mini-base");
});

test("rejects a candidate builder report detached from its resolved inputs", async () => {
  const input = fixture();
  input.products[0]!.candidate_builder_report.resolved_inputs_sha256 = "8".repeat(64);

  await assertBlocked(input, "candidate-input-invalid", "mini-base");
});

test("rejects candidate product inputs from another build policy", async () => {
  const input = fixture();
  input.products[0]!.candidate_resolved_inputs.build_environment = {
    ...input.products[0]!.candidate_resolved_inputs.build_environment,
    policy_sha256: "8".repeat(64),
  };
  input.products[0]!.candidate_builder_report = builderReport(
    input.products[0]!.candidate_resolved_inputs,
    new TextEncoder().encode("candidate mini-base under another policy\n"),
  );

  await assertBlocked(input, "candidate-input-invalid", "mini-base");
});

test("holds dependants when a promoted product dependency is unavailable", async () => {
  const input = fixture();
  input.products[0].admissions.pop();
  const result = await computePagesReadiness(input, successfulDependencies());
  assert.equal(result.readiness.ready, false);
  assert.equal(result.site_manifest, undefined);
  assert.deepEqual(
    result.readiness.blockers.map(({ kind, product_id }) => [kind, product_id]),
    [
      ["missing-admission", "mini-base"],
      ["unpromoted-dependency", "mini-shell"],
    ],
  );
});

test("rejects candidate references left by final composition", async () => {
  const input = fixture();
  await assertBlocked(
    input,
    "candidate-reference",
    "mini-base",
    successfulDependencies({ finalCandidateReference: true }),
  );
});

test("holds wrong ABI, architecture, and promoted layer identities", async (t) => {
  await t.test("ABI", async () => {
    const input = fixture();
    input.products[0].admissions[0].record.admission.formula_metadata_update.target_abi =
      TARGET_ABI + 1;
    await assertBlocked(input, "abi-mismatch", "mini-base");
  });
  await t.test("architecture", async () => {
    const input = fixture();
    input.products[0].admissions[0].record.admission.formula_metadata_update.architecture =
      "wasm64";
    await assertBlocked(input, "architecture-mismatch", "mini-base");
  });
  await t.test("layer", async () => {
    const input = fixture();
    input.products[0].admissions[0].record.admission.promoted_layer.sha256 = "9".repeat(64);
    await assertBlocked(input, "layer-mismatch", "mini-base");
  });
});

test("holds stale manifest, registry, and runtime authority", async (t) => {
  await t.test("manifest", async () => {
    const input = fixture();
    input.catalog.products[0].manifest.output = "drifted.vfs";
    await assertBlocked(input, "manifest-stale");
  });
  await t.test("registry", async () => {
    const input = fixture();
    input.authority.pages_registry_sha256 = "8".repeat(64);
    await assertBlocked(input, "registry-stale");
  });
  await t.test("runtime", async () => {
    const input = fixture();
    input.authority.runtime_bundle_sha256 = "8".repeat(64);
    await assertBlocked(input, "runtime-stale");
  });
});

test("holds final builder failure without attempting a partial site", async () => {
  await assertBlocked(
    fixture(),
    "builder-failure",
    "mini-base",
    successfulDependencies({ builderFailure: "mini-base" }),
  );
});

test("holds Node and browser evidence failure or timeout", async (t) => {
  await t.test("Node failure", async () => {
    await assertBlocked(
      fixture(),
      "node-evidence-failure",
      "mini-base",
      successfulDependencies({ evidence: ["node", "failure"] }),
    );
  });
  await t.test("browser failure", async () => {
    await assertBlocked(
      fixture(),
      "browser-evidence-failure",
      "mini-base",
      successfulDependencies({ evidence: ["browser", "failure"] }),
    );
  });
  await t.test("browser timeout", async () => {
    await assertBlocked(
      fixture(),
      "browser-evidence-timeout",
      "mini-base",
      successfulDependencies({ evidence: ["browser", "timeout"] }),
    );
  });
});

test("binds every readiness receipt to the protected evidence definition", async (t) => {
  await t.test("rejects a receipt carrying another definition digest", async () => {
    const input = fixture();
    const dependencies = successfulDependencies({ wrongDefinitionDigest: true });
    await assertBlocked(input, "node-evidence-failure", "mini-base", dependencies);
  });

  await t.test("rejects a test registration selecting the wrong host", async () => {
    const input = fixture();
    const selected = input.evidence_definitions.value.definitions.find(
      (definition) => definition.id === "mini-base-node",
    )!;
    selected.host = "browser";
    input.authority.evidence_definitions_sha256 = digest(input.evidence_definitions.value);
    await assertBlocked(input, "registry-stale");
  });

  await t.test("rejects an empty required host set", async () => {
    const input = fixture();
    input.test_registry.value.registrations.find(
      (registration) => registration.product === "mini-base",
    )!.node = [];
    input.authority.test_registry_sha256 = digest(input.test_registry.value);
    await assertBlocked(input, "registry-stale", "mini-base");
  });
});

test("requires site metadata to cover exactly the Pages registry", async (t) => {
  await t.test("missing gallery product", async () => {
    const input = fixture();
    input.site_metadata.products.pop();
    await assertBlocked(input, "gallery-product-missing");
  });
  await t.test("extra gallery product", async () => {
    const input = fixture();
    input.site_metadata.products.push({
      gallery_entries: [],
      id: "not-on-pages",
      vfs_image: "not-on-pages",
    });
    await assertBlocked(input, "gallery-product-extra");
  });
});

test("does not turn informational non-Pages evidence into a global gate", async () => {
  const result = await computePagesReadiness(
    fixture(),
    successfulDependencies({ informationalFailure: true }),
  );
  assert.equal(result.readiness.ready, true);
  assert.deepEqual(result.readiness.blockers, []);
});

async function assertBlocked(
  input: PagesReadinessInputV1,
  kind: string,
  productId?: string,
  dependencies = successfulDependencies(),
): Promise<void> {
  const result = await computePagesReadiness(input, dependencies);
  assert.equal(result.readiness.ready, false);
  assert.equal(result.site_manifest, undefined);
  assert.equal(
    result.readiness.blockers.some(
      (blocker) => blocker.kind === kind &&
        (productId === undefined || blocker.product_id === productId),
    ),
    true,
    `missing ${kind} blocker in ${JSON.stringify(result.readiness.blockers)}`,
  );
}

function fixture(): PagesReadinessInputV1 {
  const catalog = {
    kind: "kandelo-vfs-product-catalog" as const,
    products: [
      catalogProduct("mini-base", []),
      catalogProduct("mini-shell", ["mini-base"]),
      catalogProduct("mini-background", []),
    ],
    schema: 1 as const,
  };
  const pagesRegistry = {
    kind: "kandelo-pages-vfs-products" as const,
    products: [
      { id: "mini-base", load: "eager" as const },
      { id: "mini-shell", load: "lazy" as const },
    ],
    schema: 1 as const,
  };
  const testRegistry = {
    kind: "kandelo-test-vfs-products" as const,
    registrations: [
      registration("mini-background", "informational"),
      registration("mini-base", "required"),
      registration("mini-shell", "required"),
    ],
    schema: 1 as const,
  };
  const evidenceDefinitions = {
    definitions: testRegistry.registrations.flatMap((registration) => [
      ...registration.node.map((id) => ({
        definition_sha256: sha256(new TextEncoder().encode(id)),
        host: "node" as const,
        id,
        implementation: [],
        probe: {},
        runner: "exec",
        timeout_seconds: 30,
      })),
      ...registration.browser.map((id) => ({
        definition_sha256: sha256(new TextEncoder().encode(id)),
        host: "browser" as const,
        id,
        implementation: [],
        probe: {},
        runner: "exec",
        timeout_seconds: 30,
      })),
    ]),
    kind: "kandelo-vfs-evidence-definitions" as const,
    schema: 1 as const,
    version: 1,
  };
  const runtimeBundle = {
    build_policy_sha256: POLICY,
    dev_shell_lock_sha256: DEV_SHELL_LOCK,
    kind: "kandelo-pages-runtime-identity",
    schema: 1,
    source: SOURCE,
    target_abi: { snapshot_sha256: SNAPSHOT, version: TARGET_ABI },
  };
  const siteMetadata = {
    api: artifact("api"),
    browser: artifact("browser"),
    documentation: artifact("documentation"),
    kind: "kandelo-pages-site-metadata" as const,
    products: [
      { gallery_entries: [], id: "mini-base", vfs_image: "base" },
      { gallery_entries: ["shell"], id: "mini-shell", vfs_image: "shell" },
    ],
    schema: 1 as const,
  };
  const input = {
    authority: {
      catalog_sha256: digest(catalog),
      evidence_definitions_sha256: digest(evidenceDefinitions),
      pages_registry_sha256: digest(pagesRegistry),
      runtime_bundle_sha256: digest(runtimeBundle),
      site_metadata_sha256: digest(siteMetadata),
      test_registry_sha256: digest(testRegistry),
    },
    catalog,
    evidence_definitions: {
      path: "abi/staging/evidence-definitions.generated.json",
      value: evidenceDefinitions,
    },
    pages_registry: {
      path: "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml",
      value: pagesRegistry,
    },
    products: [] as PagesReadinessInputV1["products"],
    runtime_bundle: runtimeBundle,
    site_metadata: siteMetadata,
    source: SOURCE,
    target_abi: { snapshot_sha256: SNAPSHOT, version: TARGET_ABI },
    test_registry: {
      path: "tests/vfs-products.toml",
      value: testRegistry,
    },
  } satisfies PagesReadinessInputV1;

  const base = candidateProduct(input, "mini-base", [
    bottleInput("base", "embedded"),
    bottleInput("tool", "lazy-reference"),
  ]);
  const shell = candidateProduct(input, "mini-shell", [
    {
      architecture: "wasm32",
      bytes: base.candidate_builder_report.output.bytes,
      declared_materialization: "embedded",
      effective_materialization: "embedded",
      id: "product-mini-base",
      kind: "product-image",
      path: "inputs/objects/product-mini-base",
      reference: candidateReference(
        "products/mini-base",
        base.candidate_builder_report.output.sha256,
      ),
      role: "runtime",
      sha256: base.candidate_builder_report.output.sha256,
    },
  ]);
  input.products.push(base, shell);
  return structuredClone(input);
}

function sevenProductFixture(): PagesReadinessInputV1 {
  const input = fixture();
  for (const id of [
    "mini-editor",
    "mini-files",
    "mini-network",
    "mini-tools",
    "mini-workspace",
  ]) {
    input.catalog.products.push(catalogProduct(id, []));
    input.pages_registry.value.products.push({ id, load: "lazy" });
    const registered = registration(id, "required");
    input.test_registry.value.registrations.push(registered);
    input.evidence_definitions.value.definitions.push(
      ...registered.node.map((definitionId) => ({
        definition_sha256: sha256(new TextEncoder().encode(definitionId)),
        host: "node" as const,
        id: definitionId,
        implementation: [],
        probe: {},
        runner: "exec",
        timeout_seconds: 30,
      })),
      ...registered.browser.map((definitionId) => ({
        definition_sha256: sha256(new TextEncoder().encode(definitionId)),
        host: "browser" as const,
        id: definitionId,
        implementation: [],
        probe: {},
        runner: "exec",
        timeout_seconds: 30,
      })),
    );
    input.site_metadata.products.push({
      gallery_entries: [],
      id,
      vfs_image: id,
    });
    input.products.push(candidateProduct(input, id, []));
  }
  input.authority.catalog_sha256 = digest(input.catalog);
  input.authority.evidence_definitions_sha256 = digest(input.evidence_definitions.value);
  input.authority.pages_registry_sha256 = digest(input.pages_registry.value);
  input.authority.site_metadata_sha256 = digest(input.site_metadata);
  input.authority.test_registry_sha256 = digest(input.test_registry.value);
  return input;
}

function hostileProductIdFixture(): PagesReadinessInputV1 {
  const input = fixture();
  const hostileId = "../escape";
  const catalogEntry = input.catalog.products.find(
    ({ manifest }) => manifest.id === "mini-base",
  )!;
  catalogEntry.manifest.id = hostileId;
  catalogEntry.sha256 = digest(catalogEntry.manifest);
  input.catalog.products = [catalogEntry];
  input.pages_registry.value.products = [{ id: hostileId, load: "eager" }];
  const registration = input.test_registry.value.registrations.find(
    ({ product }) => product === "mini-base",
  )!;
  registration.product = hostileId;
  input.test_registry.value.registrations = [registration];
  input.site_metadata.products = [{
    gallery_entries: [],
    id: hostileId,
    vfs_image: "escape",
  }];
  const product = input.products.find(({ id }) => id === "mini-base")!;
  product.id = hostileId;
  product.candidate_resolved_inputs.product = productIdentity(catalogEntry);
  product.current_resolved_inputs.product = productIdentity(catalogEntry);
  product.candidate_builder_report = builderReport(
    product.candidate_resolved_inputs,
    new TextEncoder().encode("hostile candidate VFS\n"),
  );
  input.products = [product];
  input.authority.catalog_sha256 = digest(input.catalog);
  input.authority.pages_registry_sha256 = digest(input.pages_registry.value);
  input.authority.site_metadata_sha256 = digest(input.site_metadata);
  input.authority.test_registry_sha256 = digest(input.test_registry.value);
  return input;
}

function candidateProduct(
  input: Omit<PagesReadinessInputV1, "products"> & {
    products: PagesReadinessInputV1["products"];
  },
  id: string,
  inputs: Array<Record<string, any>>,
): PagesReadinessInputV1["products"][number] {
  const selected = input.catalog.products.find((entry) => entry.manifest.id === id)!;
  const resolved: PagesReadinessInputV1["products"][number]["candidate_resolved_inputs"] = {
    build_environment: {
      dev_shell_lock_sha256: DEV_SHELL_LOCK,
      policy_sha256: POLICY,
    },
    inputs: inputs as PagesReadinessInputV1["products"][number]["candidate_resolved_inputs"]["inputs"],
    kind: "kandelo-resolved-vfs-product-inputs",
    product: productIdentity(selected),
    reference_class: "candidate",
    schema: 1,
    source: SOURCE,
    target_abi: input.target_abi,
  };
  const candidateVfs = new TextEncoder().encode(`candidate ${id} with -candidates/ references\n`);
  const report = builderReport(resolved, candidateVfs);
  const formulae = inputs
    .filter((value) => value.kind === "homebrew-bottle")
    .map((value) => String(value.id).replace(/^homebrew-/, ""));
  return {
    admissions: formulae.map((formula) => admission(formula, inputs)),
    candidate_builder_report: report,
    candidate_resolved_inputs: resolved,
    current_resolved_inputs: structuredClone(resolved),
    id,
  };
}

function successfulDependencies(options: {
  builderFailure?: string;
  evidence?: ["node" | "browser", "failure" | "timeout"];
  finalCandidateReference?: boolean;
  informationalFailure?: boolean;
  wrongDefinitionDigest?: boolean;
  canonicalOciMutation?: "layer" | "metadata";
} = {}): PagesReadinessDependencies {
  return {
    async validateAdmissionRecord(recordBytes: Uint8Array) {
      const record = JSON.parse(new TextDecoder().decode(recordBytes));
      if (
        record.admission?.canonical_public_readback_sha256 !==
          record.admission?.canonical?.sha256
      ) {
        throw new Error("admission canonical public readback differs");
      }
    },
    async fetchCanonicalOci(reference: string) {
      const formula = reference.match(/homebrew-tap-core-abi-[0-9]+\/([^/@]+)@sha256:/u)?.[1];
      if (formula === undefined) throw new Error("canonical fixture reference is malformed");
      const readback = canonicalBottleOci(formula);
      if (options.canonicalOciMutation === "metadata") {
        readback.bottle_metadata = new TextEncoder().encode("forged metadata\n");
      } else if (options.canonicalOciMutation === "layer") {
        readback.bottle_layer = new TextEncoder().encode("forged bottle layer\n");
      }
      return readback;
    },
    async buildProduct(request: CanonicalProductBuildRequestV1) {
      if (options.builderFailure === request.product.id) {
        throw new Error("injected final builder failure");
      }
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
      fs.mkdir("/usr", 0o755);
      fs.mkdir("/usr/bin", 0o755);
      const payload = new TextEncoder().encode(
        `${request.product.id}:${digest(request.resolved_inputs)}\n`,
      );
      writeFile(fs, "/usr/bin/ready", payload);
      const lazy = request.resolved_inputs.inputs.find(
        (value) => value.effective_materialization === "lazy-reference",
      );
      if (lazy !== undefined) {
        const reference = options.finalCandidateReference
          ? candidateReference("tool", lazy.sha256)
          : lazy.reference;
        fs.registerLazyFile("/usr/bin/lazy-tool", reference!, lazy.bytes, 0o755);
      }
      const vfs = await fs.saveImage({
        metadata: {
          abiSnapshotSha256: SNAPSHOT,
          kernelAbi: TARGET_ABI,
          version: 1,
        },
        normalizeTimestampsMs: 0,
      });
      return {
        builder_report: builderReport(request.resolved_inputs, vfs),
        vfs,
      };
    },
    async runEvidence(request: PagesEvidenceRequestV1) {
      const configured = options.evidence;
      const outcome = configured?.[0] === request.host &&
          request.product.id === "mini-base"
        ? configured[1]
        : "success";
      if (options.informationalFailure && request.product.id === "mini-background") {
        return evidenceReceipt(request, "failure");
      }
      const receipt = evidenceReceipt(request, outcome);
      if (options.wrongDefinitionDigest && request.product.id === "mini-base") {
        receipt.definition.definition_sha256 = "f".repeat(64);
      }
      return receipt;
    },
  };
}

function evidenceReceipt(
  request: PagesEvidenceRequestV1,
  outcome: "success" | "failure" | "timeout",
) {
  const vfsSha256 = sha256(request.vfs);
  const builderReportSha256 = digest(request.builder_report);
  const runtime = evidenceRuntimeIdentity(request.runtime_bundle_sha256);
  return {
    bounded_diagnostics: [],
    candidate_product: {
      builder_report_sha256: builderReportSha256,
      manifest_digest: `sha256:${vfsSha256}`,
      vfs_layer_bytes: request.vfs.byteLength,
      vfs_layer_sha256: vfsSha256,
    },
    definition: {
      definition_sha256: request.definition_sha256,
      id: request.definition_id,
    },
    guard_codes: outcome === "success"
      ? []
      : outcome === "failure"
      ? ["verification_failed"]
      : ["verification_timeout"],
    host: request.host,
    kind: "kandelo-vfs-product-evidence-result",
    outcome,
    product: {
      id: request.product.id,
      manifest_sha256: request.product.manifest_sha256,
    },
    request_digest: digest({
      builder_report_sha256: builderReportSha256,
      definition_sha256: request.definition_sha256,
      host: request.host,
      product_id: request.product.id,
      runtime_bundle_sha256: request.runtime_bundle_sha256,
      vfs_sha256: vfsSha256,
    }),
    run: {
      attempt: 1,
      job_id: `pages-${request.host}-evidence`,
      repository: "Automattic/kandelo",
      run_id: 101,
      workflow_ref:
        "Automattic/kandelo/.github/workflows/abi-staging-pages-canary.yml@refs/heads/main",
    },
    runtime,
    schema: 1,
  };
}

function evidenceRuntimeIdentity(bundleSha256: string) {
  const kernelSha256 = "6".repeat(64);
  return {
    browser: {
      bundle_sha256: "7".repeat(64),
      bytes: 1,
      harness_entry_bytes: 1,
      harness_entry_path: "browser/dist/abi-staging-harness/index.html",
      harness_entry_sha256: "8".repeat(64),
      host_entry_bytes: 1,
      host_entry_path: "browser/dist/abi-staging/browser-host.js",
      host_entry_sha256: "9".repeat(64),
      kernel_asset_path: "browser/dist/assets/kernel.wasm",
      kernel_asset_sha256: kernelSha256,
      service_worker_sha256: "a".repeat(64),
    },
    build_policy_sha256: POLICY,
    bundle_sha256: bundleSha256,
    host_runtime: {
      bundle_sha256: "b".repeat(64),
      bytes: 1,
      generated_abi_sha256: "c".repeat(64),
      worker_protocol_sha256: "d".repeat(64),
    },
    kernel: {
      abi_version: TARGET_ABI,
      bytes: 1,
      snapshot_sha256: SNAPSHOT,
      wasm_sha256: kernelSha256,
    },
    source: SOURCE,
    target_abi: {
      snapshot_sha256: SNAPSHOT,
      version: TARGET_ABI,
    },
  };
}

function builderReport(resolved: any, vfs: Uint8Array) {
  return {
    capture: { complete: true, unreported_reads: [] },
    inputs: resolved.inputs.map((input: any) => ({
      bytes: input.bytes,
      ...(input.descriptor === undefined
        ? {}
        : {
          descriptor: {
            bytes: input.descriptor.bytes,
            sha256: input.descriptor.sha256,
          },
        }),
      id: input.id,
      kind: input.kind,
      placement: input.effective_materialization,
      role: input.role,
      sha256: input.sha256,
    })),
    kind: "kandelo-vfs-builder-report",
    output: {
      abi: resolved.target_abi,
      bytes: vfs.byteLength,
      name: resolved.product.output,
      path: resolved.product.output,
      sha256: sha256(vfs),
    },
    product: resolved.product,
    resolved_inputs_sha256: digest(resolved),
    schema: 1,
  };
}

function catalogProduct(id: string, dependencies: string[]) {
  const manifest = {
    architecture: "wasm32" as const,
    boot: {
      argv: ["/usr/bin/ready"],
      cwd: "/",
      env: {},
      gid: 0,
      uid: 0,
    },
    builder: "images/vfs/scripts/build-abi-staging-mini-vfs.ts",
    composition: {
      archive: [],
      product: dependencies.map((dependency) => ({
        id: dependency,
        materialization: "embedded",
      })),
      repository: [],
      toolchain: [],
    },
    evidence: {
      browser: { test: `${id}-browser` },
      node: { test: `${id}-node` },
    },
    id,
    mounts: [],
    output: `${id}.vfs`,
    schema: 1,
    software: { formula: [], package: [] },
  };
  return {
    manifest,
    path: `images/vfs/products/${id}.toml`,
    sha256: digest(manifest),
  };
}

function registration(product: string, applicability: "required" | "informational") {
  return {
    applicability: {
      abi: applicability,
      host: applicability,
      kernel: applicability,
    },
    browser: [`${product}-browser`],
    node: [`${product}-node`],
    product,
  };
}

function productIdentity(entry: any) {
  return {
    architecture: entry.manifest.architecture,
    id: entry.manifest.id,
    manifest_path: entry.path,
    manifest_sha256: entry.sha256,
    output: entry.manifest.output,
  };
}

function bottleInput(formula: string, placement: "embedded" | "lazy-reference") {
  const bytes = new TextEncoder().encode(`${formula} bottle layer\n`);
  const descriptor = compositionDescriptorBytes(formula, bytes, "candidate");
  const sha = sha256(bytes);
  const descriptorSha = sha256(descriptor);
  return {
    architecture: "wasm32",
    bytes: bytes.byteLength,
    declared_materialization: placement === "embedded" ? "embedded" : "lazy",
    descriptor: {
      bytes: descriptor.byteLength,
      path: `inputs/objects/homebrew-${formula}-metadata`,
      reference: candidateReference(formula, descriptorSha),
      sha256: descriptorSha,
    },
    effective_materialization: placement,
    id: `homebrew-${formula}`,
    kind: "homebrew-bottle",
    ...(placement === "embedded"
      ? { path: `inputs/objects/homebrew-${formula}` }
      : {}),
    reference: candidateReference(formula, sha),
    role: "runtime",
    sha256: sha,
  };
}

function admission(formula: string, inputs: Array<Record<string, any>>) {
  const input = inputs.find((value) => value.id === `homebrew-${formula}`)!;
  const readback = canonicalBottleOci(formula);
  assert.equal(input.sha256, readback.bottle_layer_identity.sha256);
  assert.equal(input.bytes, readback.bottle_layer_identity.bytes);
  assert.notEqual(
    input.descriptor.sha256,
    sha256(readback.vfs_composition_descriptor),
  );
  const canonicalManifest = sha256(readback.manifest);
  const record = {
    admission: {
      abi_history_record_sha256: "6".repeat(64),
      candidate_binding_sha256: "7".repeat(64),
      candidate_record_sha256: "7".repeat(64),
      canonical: {
        bytes: readback.manifest.byteLength,
        immutable_reference: canonicalReference(formula, canonicalManifest),
        sha256: canonicalManifest,
      },
      canonical_public_readback_sha256: canonicalManifest,
      formula_metadata_source: {
        commit: "9".repeat(40),
        repository: "kandelo-dev/homebrew-tap-core",
        tree: "a".repeat(40),
      },
      formula_metadata_update: {
        allowed_paths: [
          `Formula/${formula}.rb`,
          `Kandelo/formula/${formula}.json`,
          "Kandelo/metadata.json",
          `Kandelo/link/${formula}-1-rebuild0-wasm32.json`,
        ],
        architecture: "wasm32",
        bottle_layer_bytes: input.bytes,
        bottle_layer_sha256: input.sha256,
        canonical_manifest_digest: canonicalManifest,
        expected_generated_metadata_sha256: "b".repeat(64),
        expected_main_commit: "c".repeat(40),
        expected_normalized_formula_sha256: "d".repeat(64),
        formula,
        link_manifest_path: `Kandelo/link/${formula}-1-rebuild0-wasm32.json`,
        link_manifest_sha256: "e".repeat(64),
        target_abi: TARGET_ABI,
      },
      merged_pull_request: {
        head: SOURCE.commit,
        merge_commit: "f".repeat(40),
        number: 1,
        repository: SOURCE.repository,
      },
      original_producer: {
        head: SOURCE.commit,
        request_sha256: "0".repeat(64),
        run_id: 1,
      },
      preactivation_tap_source: {
        commit: "0".repeat(40),
        repository: "kandelo-dev/homebrew-tap-core",
        tree: "1".repeat(40),
      },
      promoted_layer: {
        bytes: input.bytes,
        immutable_reference: candidateReference(formula, input.sha256),
        sha256: input.sha256,
      },
      qualifying_receipt_sha256s: ["2".repeat(64)],
      tap_source: {
        commit: "c".repeat(40),
        repository: "kandelo-dev/homebrew-tap-core",
        tree: "3".repeat(40),
      },
    },
    common: {
      artifact: {
        bytes: readback.manifest.byteLength,
        immutable_reference: canonicalReference(formula, canonicalManifest),
        sha256: canonicalManifest,
      },
      artifact_class: "canonical",
      blockers: [],
      guard_codes: [],
      outcome: "success",
      promotion_state: "promoted",
      request_sha256: "0".repeat(64),
      retry_state: {
        attempts: 0,
        eligible: false,
        exhausted: false,
        next_action: "none",
      },
      run: {
        job: "publish-admission",
        repository: "kandelo-dev/homebrew-tap-core",
        run_attempt: 1,
        run_id: 1,
        workflow_ref: ".github/workflows/abi-staging-reconcile.yml@refs/heads/main",
      },
      source: SOURCE,
      subject: { identity: "7".repeat(64), kind: "candidate" },
      work_state: "complete",
    },
    kind: "kandelo-abi-staging-admission",
    schema: 1,
  };
  const recordSha256 = digest(record);
  const admissionManifestSha256 = sha256(
    new TextEncoder().encode(`admission manifest ${formula}\n`),
  );
  assert.notEqual(admissionManifestSha256, recordSha256);
  return {
    immutable_reference:
      `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${TARGET_ABI}/${formula}/admissions@sha256:${admissionManifestSha256}`,
    record,
    record_sha256: recordSha256,
  };
}

function authenticatedAdmissions(
  product: PagesReadinessInputV1["products"][number],
) {
  return product.admissions.map((envelope) => {
    const formula = String(
      envelope.record.admission.formula_metadata_update.formula,
    );
    const input = product.candidate_resolved_inputs.inputs.find(
      (value) => value.id === `homebrew-${formula}`,
    )!;
    return {
      ...structuredClone(envelope),
      canonical_bottle_layer: {
        body: new Uint8Array(canonicalBottleOci(formula).bottle_layer),
        bytes: canonicalBottleOci(formula).bottle_layer.byteLength,
        sha256: sha256(canonicalBottleOci(formula).bottle_layer),
      },
      canonical_vfs_composition_descriptor: {
        body: new Uint8Array(
          canonicalBottleOci(formula).vfs_composition_descriptor,
        ),
        bytes: canonicalBottleOci(formula).vfs_composition_descriptor.byteLength,
        immutable_reference: canonicalReference(
          formula,
          sha256(canonicalBottleOci(formula).vfs_composition_descriptor),
        ),
        sha256: sha256(canonicalBottleOci(formula).vfs_composition_descriptor),
      },
    };
  });
}

function canonicalBottleOci(formula: string) {
  const bottleLayer = new TextEncoder().encode(`${formula} bottle layer\n`);
  const bottleMetadata = new TextEncoder().encode(`{"formula":"${formula}"}\n`);
  const compositionDescriptor = compositionDescriptorBytes(
    formula,
    bottleLayer,
    "canonical",
  );
  const bottleSha = sha256(bottleLayer);
  const metadataSha = sha256(bottleMetadata);
  const compositionSha = sha256(compositionDescriptor);
  const config = {
    bottle_layer: { bytes: bottleLayer.byteLength, sha256: bottleSha },
    bottle_metadata: { bytes: bottleMetadata.byteLength, sha256: metadataSha },
    candidate_record_sha256: "7".repeat(64),
    classification: "canonical-pending-admission",
    formula: {
      architecture: "wasm32",
      name: formula,
      tap: "kandelo-dev/homebrew-tap-core",
      target_abi: TARGET_ABI,
    },
    kind: "kandelo-homebrew-canonical-bottle",
    merged_pull_request: {
      head: SOURCE.commit,
      merge_commit: "f".repeat(40),
      number: 1,
      repository: SOURCE.repository,
    },
    request_sha256: "0".repeat(64),
    schema: 1,
    vfs_composition_descriptor: {
      bytes: compositionDescriptor.byteLength,
      sha256: compositionSha,
    },
  };
  const configBytes = canonicalJsonBytes(config);
  const descriptor = (
    body: Uint8Array,
    role: string,
    mediaType: string,
    title: string,
  ) => ({
    annotations: {
      "dev.kandelo.abi-staging.role": role,
      "org.opencontainers.image.title": title,
    },
    digest: `sha256:${sha256(body)}`,
    mediaType,
    size: body.byteLength,
  });
  const artifactType = "application/vnd.kandelo.homebrew.canonical-bottle.v1+json";
  const manifest = canonicalJsonBytes({
    annotations: {
      "dev.kandelo.abi-staging.candidate-record-sha256": "7".repeat(64),
      "dev.kandelo.abi-staging.classification": "canonical-pending-admission",
      "dev.kandelo.abi-staging.formula": formula,
      "dev.kandelo.abi-staging.kind": "canonical-bottle",
      "dev.kandelo.abi-staging.target-abi": String(TARGET_ABI),
      "org.opencontainers.image.source":
        "https://github.com/kandelo-dev/homebrew-tap-core",
    },
    artifactType,
    config: descriptor(
      configBytes,
      "canonical-bottle-metadata",
      artifactType,
      "canonical-bottle.json",
    ),
    layers: [
      descriptor(
        bottleLayer,
        "bottle-layer",
        "application/vnd.kandelo.homebrew.bottle.layer.v1+tar+gzip",
        `${formula}.tar.gz`,
      ),
      descriptor(
        bottleMetadata,
        "bottle-metadata",
        "application/vnd.kandelo.homebrew.bottle.metadata.v1+json",
        "bottle-metadata.json",
      ),
      descriptor(
        compositionDescriptor,
        "vfs-composition-descriptor",
        "application/vnd.kandelo.homebrew.vfs-composition-descriptor.v1+json",
        "vfs-composition-descriptor.json",
      ),
    ],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  return {
    bottle_layer: bottleLayer,
    bottle_layer_identity: {
      bytes: bottleLayer.byteLength,
      sha256: bottleSha,
    },
    bottle_metadata: bottleMetadata,
    config: configBytes,
    manifest,
    vfs_composition_descriptor: compositionDescriptor,
  };
}

function compositionDescriptorBytes(
  formula: string,
  bottle: Uint8Array,
  referenceClass: "candidate" | "canonical",
): Uint8Array {
  const suffix = referenceClass === "candidate" ? "-candidates" : "";
  return canonicalJsonBytes({
    architecture: "wasm32",
    formula,
    kind: "kandelo-homebrew-original-bottle-tree",
    required_by: [formula],
    schema: 1,
    tap: "kandelo-dev/homebrew-tap-core",
    tree: {
      activation: {
        capabilities: [`homebrew-bottle:${formula}`],
        mode: "first-use",
        roots: [`/opt/kandelo/homebrew/Cellar/${formula}/1`],
      },
      content: {
        bytes: bottle.byteLength,
        decoder: "homebrew-bottle-tar-gzip-v1",
        media_type: "application/vnd.oci.image.layer.v1.tar+gzip",
        sha256: sha256(bottle),
      },
      id: formula,
      inventory: {},
      package: `kandelo-dev/tap-core/${formula}`,
      transports: [{
        kind: "external-https",
        url:
          `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-${TARGET_ABI}` +
          `${suffix}/${formula}/blobs/sha256:${sha256(bottle)}`,
      }],
    },
  });
}

function candidateReference(subject: string, digestValue: string): string {
  return `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${TARGET_ABI}-candidates/${subject}@sha256:${digestValue}`;
}

function canonicalReference(subject: string, digestValue: string): string {
  return `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${TARGET_ABI}/${subject}@sha256:${digestValue}`;
}

function artifact(label: string) {
  const body = new TextEncoder().encode(`${label}\n`);
  return {
    bytes: body.byteLength,
    path: label,
    sha256: sha256(body),
  };
}

function inputIdentity(input: Record<string, any>) {
  return {
    bytes: input.bytes,
    declared_materialization: input.declared_materialization,
    effective_materialization: input.effective_materialization,
    id: input.id,
    kind: input.kind,
    role: input.role,
    sha256: input.sha256,
  };
}

function writeFile(fs: MemoryFileSystem, path: string, bytes: Uint8Array): void {
  const descriptor = fs.open(path, 0x40 | 0x2, 0o755);
  try {
    assert.equal(fs.write(descriptor, bytes, null, bytes.byteLength), bytes.byteLength);
  } finally {
    fs.close(descriptor);
  }
}

function digest(value: unknown): string {
  return sha256(canonicalJsonBytes(value));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
