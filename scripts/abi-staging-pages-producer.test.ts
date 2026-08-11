import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRepositoryPathBundle } from "../images/vfs/scripts/repository-path-bundle.ts";

import {
  bindAdmissionProjections,
  canonicalJsonBytes,
  createLocalLazyFetcher,
  createExactSourceReobserver,
  derivePagesSiteMetadata,
  discoverAdmissions,
  discoverCandidateProductAuthority,
  heldPagesReadinessRecord,
  immutableRecordReferencesFromTags,
  isExpectedCurrentInputUnavailable,
  producePagesArtifacts,
  readCandidateProductAuthority,
  rebuildCurrentResolvedInputs,
  validateCandidateProductReference,
  validatePagesProductionHandoff,
  writeAtomicHoldOnlyOutput,
} from "./abi-staging-pages-producer.ts";
import {
  createMiniaturePagesProducerFixture,
} from "./abi-staging-pages-producer-fixture.ts";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const source = {
  repository: "Automattic/kandelo",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
};
const targetAbi = { version: 18, snapshot_sha256: "3".repeat(64) };

test("serves exact local lazy bytes under their canonical transport identity", async () => {
  const body = new TextEncoder().encode("current canonical lazy bytes\n");
  const digest = sha256(body);
  const url =
    `https://automattic.github.io/kandelo/products/inputs/package-dash/` +
    `sha256-${digest}/package-dash?sha256=${digest}&bytes=${body.byteLength}`;
  const factory = createLocalLazyFetcher(new Map([
    [url, { body, bytes: body.byteLength, sha256: digest }],
  ]));
  const fetchLazy = factory([{ url, sourceUrl: url, sha256: digest, size: body.byteLength }]);
  const response = await fetchLazy(url);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
  await assert.rejects(
    () => fetchLazy(`${url}&hostile=1`),
    /closed local lazy transport/i,
  );
  assert.throws(
    () => factory([{ url, sourceUrl: url, sha256: "f".repeat(64), size: body.byteLength }]),
    /differs from its exact body/i,
  );
});

test("re-observes exact clean source identity after protected execution", () => {
  let clean = true;
  let observations = 0;
  const reobserve = createExactSourceReobserver({
    commit: source.commit,
    devShellLockSha256: "4".repeat(64),
    root: "/protected/source",
    tree: source.tree,
  }, () => {
    observations++;
    if (!clean) throw new Error("exact source checkout has tracked mutation");
  });
  clean = false;
  assert.throws(reobserve, /tracked mutation/i);
  assert.equal(observations, 2);
});

test("emits canonical hold-only readiness for expected product incompleteness", () => {
  const readiness = heldPagesReadinessRecord({
    blockers: [{
      detail: "mini has no immutable current-tree candidate",
      kind: "candidate-input-missing",
      product_id: "mini",
    }],
    pagesRegistry: {
      path: "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
      products: [{ id: "mini", load: "eager" }],
      sha256: "5".repeat(64),
    },
    siteMetadataSha256: "6".repeat(64),
    source,
    tapSource: {
      commit: "4".repeat(40),
      repository: "kandelo-dev/homebrew-tap-core",
      tree: "5".repeat(40),
    },
    targetAbi,
  });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.products, []);
  assert.equal(readiness.blockers[0]!.guard_code, "pages_product_incomplete");
  assert.equal(readiness.blockers[0]!.product_id, "mini");
  assert.equal("site_manifest" in readiness, false);
});

test("atomically publishes only readiness for a hold", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-hold-output-"));
  try {
    const staging = join(root, ".staging");
    const output = join(root, "output");
    mkdirSync(join(staging, "current-inputs"), { recursive: true });
    writeFileSync(join(staging, "current-inputs", "unpublished.bin"), "private\n");
    writeAtomicHoldOnlyOutput(staging, output, { ready: false });
    assert.deepEqual(readdirSync(output), ["readiness.json"]);
    assert.equal(existsSync(staging), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("holds only for absent current artifacts and rejects protected identity drift", () => {
  const missing = Object.assign(new Error("package root is unavailable"), { code: "ENOENT" });
  assert.equal(isExpectedCurrentInputUnavailable(missing), true);
  assert.equal(
    isExpectedCurrentInputUnavailable(
      new Error("current-main source tree differs from the candidate-proven source tree"),
    ),
    false,
  );
});

test("authenticates candidate inputs from immutable OCI without fetching candidate VFS", async () => {
  const fixture = candidateOciFixture();
  const fetched: string[] = [];
  const authenticated = await readCandidateProductAuthority(
    fixture.reference,
    {
      productId: "mini",
      source,
      targetAbi,
    },
    {
      async fetchManifest(reference) {
        assert.equal(reference, fixture.reference);
        return fixture.manifest;
      },
      async fetchBlob(_repository, digest, bytes) {
        fetched.push(digest);
        const body = fixture.blobs.get(digest);
        assert.ok(body, `unexpected blob ${digest}`);
        assert.equal(body.byteLength, bytes);
        return body;
      },
    },
  );

  assert.deepEqual(authenticated.resolvedInputs, fixture.resolved);
  assert.deepEqual(authenticated.builderReport, fixture.report);
  assert.equal(authenticated.lazyInputs.get("package-tool-output-tool")?.sha256,
    fixture.resolved.inputs[1]!.sha256);
  assert.equal(fetched.includes(`sha256:${fixture.vfsSha256}`), false);
  assert.equal(fetched.includes(`sha256:${fixture.resolved.inputs[1]!.sha256}`), false);
});

test("rejects dotted product reference confusion and oversized candidate descriptors", async () => {
  assert.throws(
    () => validateCandidateProductReference(
      `ghcr.io/kandelo-dev/homebrew-tap-core-abi-18-candidates/` +
        `products/miniXproduct@sha256:${"a".repeat(64)}`,
      "mini.product",
      18,
    ),
    /exact ABI namespace/,
  );

  const fixture = candidateOciFixture();
  const manifest = JSON.parse(new TextDecoder().decode(fixture.manifest));
  manifest.layers[0].size = 256 * 1024 * 1024 + 1;
  const manifestBytes = canonicalJsonBytes(manifest);
  const reference = fixture.reference.replace(
    /sha256:[0-9a-f]{64}$/u,
    `sha256:${sha256(manifestBytes)}`,
  );
  await assert.rejects(
    () => readCandidateProductAuthority(reference, {
      productId: "mini",
      source,
      targetAbi,
    }, {
      async fetchManifest() { return manifestBytes; },
      async fetchBlob(_repository, digest) {
        const body = fixture.blobs.get(digest);
        if (body === undefined) {
          throw new Error("oversized descriptor must fail before its blob read");
        }
        return body;
      },
    }),
    /byte bound/,
  );
});

test("rejects a self-consistent candidate under-inventory against current main collection", () => {
  const fixture = candidateOciFixture();
  const inventory = {
    schema: 1,
    kind: "kandelo-vfs-product-input-object-inventory",
    product: Object.fromEntries(
      Object.entries(fixture.resolved.product).filter(([key]) => key !== "output"),
    ),
    source: { ...source, commit: "9".repeat(40) },
    target_abi: targetAbi,
    build_environment: fixture.resolved.build_environment,
    objects: [
      {
        ...fixture.resolved.inputs[0],
        adapter: "package-output-file-v1",
        path: "inputs/objects/package-runtime-output-runtime",
      },
      {
        ...fixture.resolved.inputs[1],
        adapter: "package-output-file-v1",
        path: "inputs/objects/package-tool-output-tool",
      },
    ],
    inventory_sha256: "4".repeat(64),
  };

  const current = rebuildCurrentResolvedInputs(fixture.resolved, inventory);
  assert.deepEqual(
    current.inputs.map((input: any) => input.path),
    [inventory.objects[0]!.path, undefined],
  );
  assert.deepEqual(current.source, inventory.source);

  const underInventory = structuredClone(fixture.resolved);
  underInventory.inputs.pop();
  assert.throws(
    () => rebuildCurrentResolvedInputs(underInventory, inventory),
    /complete current-main input inventory/,
  );

  const differentTree = structuredClone(inventory);
  differentTree.source.tree = "0".repeat(40);
  assert.throws(
    () => rebuildCurrentResolvedInputs(fixture.resolved, differentTree),
    /source tree/,
  );
});

test("recaptures a commit-sensitive repository-path bundle from the same source tree", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-repository-recapture-"));
  try {
    mkdirSync(join(root, "selected"));
    writeFileSync(join(root, "selected", "config.json"), "{\"current\":true}\n");
    const candidatePath = join(root, "candidate.json");
    const currentPath = join(root, "current.json");
    const currentSource = { ...source, commit: "9".repeat(40) };
    createRepositoryPathBundle({
      outputPath: candidatePath,
      paths: ["selected"],
      repositoryRoot: root,
      source,
    });
    createRepositoryPathBundle({
      outputPath: currentPath,
      paths: ["selected"],
      repositoryRoot: root,
      source: currentSource,
    });
    const candidateBytes = new Uint8Array(readFileSync(candidatePath));
    const currentBytes = new Uint8Array(readFileSync(currentPath));
    assert.notEqual(sha256(candidateBytes), sha256(currentBytes));
    const fixture = candidateOciFixture();
    const candidateResolved = structuredClone(fixture.resolved);
    candidateResolved.inputs.push({
      architecture: "wasm32",
      bytes: candidateBytes.byteLength,
      declared_materialization: "embedded",
      effective_materialization: "embedded",
      id: "repository-rootfs-source",
      kind: "repository-path",
      path: "inputs/objects/repository-rootfs-source-old",
      reference:
        `ghcr.io/kandelo-dev/homebrew-tap-core-abi-18-candidates/products/mini@` +
        `sha256:${sha256(candidateBytes)}`,
      repository_id: "rootfs-source",
      paths: ["selected"],
      role: "runtime",
      sha256: sha256(candidateBytes),
    });
    const inventory: any = currentInventoryForFixture(fixture, currentSource);
    inventory.objects.push({
      adapter: "repository-path-bundle-v1",
      architecture: "wasm32",
      bytes: currentBytes.byteLength,
      declared_materialization: "embedded",
      id: "repository-rootfs-source",
      kind: "repository-path",
      path: "inputs/objects/repository-rootfs-source-current",
      paths: ["selected"],
      repository_id: "rootfs-source",
      role: "runtime",
      sha256: sha256(currentBytes),
    });
    const rebuilt = rebuildCurrentResolvedInputs(candidateResolved, inventory);
    const recaptured = rebuilt.inputs.find(
      (input: any) => input.id === "repository-rootfs-source",
    );
    assert.equal(recaptured.sha256, sha256(currentBytes));
    assert.equal(recaptured.bytes, currentBytes.byteLength);
    assert.equal(recaptured.path, "inputs/objects/repository-rootfs-source-current");
    assert.equal(recaptured.reference, undefined);
    assert.equal(recaptured.repository_id, "rootfs-source");
    assert.deepEqual(recaptured.paths, ["selected"]);
    assert.deepEqual(rebuilt.source, currentSource);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("accepts only a bounded automatically collectable production handoff", () => {
  const tapSource = {
    commit: "4".repeat(40),
    repository: "kandelo-dev/homebrew-tap-core",
    tree: "5".repeat(40),
  };
  const handoff = {
    schema: 1,
    kind: "kandelo-pages-production-handoff",
    products: [{
      current_inputs: {
        archive_files: "/tmp/archive-files.json",
        package_roots: "/tmp/package-roots.json",
        program_index: "/tmp/program-index.json",
      },
      id: "mini",
    }],
    run: {
      attempt: 1,
      repository: "Automattic/kandelo",
      run_id: 7,
      workflow_ref:
        "Automattic/kandelo/.github/workflows/abi-staging-pages-canary.yml@refs/heads/main",
    },
    runtime_bundle: "/tmp/runtime-bundle.json",
    runtime_root: "/tmp/runtime",
    site_source_root: "/tmp/site-source",
    source,
    source_root: "/tmp/current-main",
    tap_root: "/tmp/current-tap-main",
    tap_source: tapSource,
    target_abi: targetAbi,
  };

  assert.deepEqual(validatePagesProductionHandoff(handoff), handoff);
  assert.throws(
    () => validatePagesProductionHandoff({
      ...handoff,
      tap_source: { ...tapSource, repository: "example/homebrew-tap-core" },
    }),
    /tap source/i,
  );
  assert.throws(
    () => validatePagesProductionHandoff({
      ...handoff,
      products: [{ ...handoff.products[0], candidate_vfs: "/tmp/candidate.vfs" }],
    }),
    /fields differ/,
  );
  assert.throws(
    () => validatePagesProductionHandoff({
      ...handoff,
      run: {
        ...handoff.run,
        workflow_ref:
          "Automattic/kandelo/.github/workflows/arbitrary.yml@refs/heads/main",
      },
    }),
    /protected main run/,
  );
  assert.throws(
    () => validatePagesProductionHandoff({
      ...handoff,
      site_metadata: "/tmp/self-authorized.json",
    }),
    /fields differ/,
  );
});

test("discovers one immutable current-tree candidate without caller locators", async () => {
  const fixture = candidateOciFixture();
  const repository = fixture.reference.split("@", 1)[0]!;
  const discovered = await discoverCandidateProductAuthority({
    productId: "mini",
    source,
    targetAbi,
  }, {
    async listImmutableReferences(selected) {
      assert.equal(selected, repository);
      return [fixture.reference];
    },
    async fetchManifest() { return fixture.manifest; },
    async fetchBlob(_repository, digest) {
      const body = fixture.blobs.get(digest);
      assert.ok(body);
      return body;
    },
  });
  assert.equal(discovered.reference, fixture.reference);
  assert.equal(discovered.authority.candidateRecord.product.id, "mini");
});

test("selects a deterministic equivalent candidate when same-tree history coexists", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-candidate-history-"));
  try {
    mkdirSync(join(root, "selected"));
    writeFileSync(join(root, "selected", "config.json"), "{\"sameTree\":true}\n");
    const firstBundlePath = join(root, "first.json");
    const secondBundlePath = join(root, "second.json");
    const secondSource = { ...source, commit: "9".repeat(40) };
    createRepositoryPathBundle({
      outputPath: firstBundlePath,
      paths: ["selected"],
      repositoryRoot: root,
      source,
    });
    createRepositoryPathBundle({
      outputPath: secondBundlePath,
      paths: ["selected"],
      repositoryRoot: root,
      source: secondSource,
    });
    const first = candidateOciFixture(
      source,
      new Uint8Array(readFileSync(firstBundlePath)),
    );
    const second = candidateOciFixture(
      secondSource,
      new Uint8Array(readFileSync(secondBundlePath)),
    );
    const conflict = candidateOciFixture(
      source,
      new Uint8Array(readFileSync(firstBundlePath)),
      ["different-reviewed-path"],
    );
    const fixtures = new Map([
      [first.reference, first],
      [second.reference, second],
      [conflict.reference, conflict],
    ]);
    const discovered = await discoverCandidateProductAuthority({
      productId: "mini",
      source,
      targetAbi,
    }, {
      async listImmutableReferences() { return [second.reference, first.reference]; },
      async fetchManifest(reference) { return fixtures.get(reference)!.manifest; },
      async fetchBlob(_repository, digest) {
        for (const fixture of fixtures.values()) {
          const body = fixture.blobs.get(digest);
          if (body !== undefined) return body;
        }
        throw new Error(`unexpected blob ${digest}`);
      },
    });
    assert.equal(discovered.reference, [first.reference, second.reference].sort()[0]);
    await assert.rejects(
      () => discoverCandidateProductAuthority({
        productId: "mini",
        source,
        targetAbi,
      }, {
        async listImmutableReferences() { return [first.reference, conflict.reference]; },
        async fetchManifest(reference) { return fixtures.get(reference)!.manifest; },
        async fetchBlob(_repository, digest) {
          for (const fixture of fixtures.values()) {
            const body = fixture.blobs.get(digest);
            if (body !== undefined) return body;
          }
          throw new Error(`unexpected blob ${digest}`);
        },
      }),
      /conflicting immutable current-tree records/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("preserves the authenticated admission manifest locator independently of record bytes", async () => {
  const manifestSha256 = "a".repeat(64);
  const repository = "ghcr.io/kandelo-dev/homebrew-tap-core-abi-18/dash/admissions";
  const [reference] = immutableRecordReferencesFromTags(repository, [
    `record-sha256-${manifestSha256}`,
  ]);
  const record = {
    admission: {
      formula_metadata_update: { architecture: "wasm32", formula: "dash", target_abi: 18 },
      promoted_layer: { bytes: 12, sha256: "b".repeat(64) },
    },
    kind: "kandelo-abi-staging-admission",
    schema: 1,
  };
  let validated = 0;
  let projected = 0;
  const projection = {
    admission_record_sha256: sha256(canonicalJsonBytes(record)),
    architecture: "wasm32",
    formula: "dash",
    formula_metadata_update_sha256: sha256(canonicalJsonBytes(
      record.admission.formula_metadata_update,
    )),
    kind: "kandelo-pages-admission-projection",
    projection_sha256: "d".repeat(64),
    schema: 1,
    tap_source: {
      commit: "4".repeat(40),
      repository: "kandelo-dev/homebrew-tap-core",
      tree: "5".repeat(40),
    },
    target_abi: 18,
  };
  const admissions = await discoverAdmissions({
    inputs: [{
      bytes: 12,
      id: "homebrew-dash",
      kind: "homebrew-bottle",
      sha256: "b".repeat(64),
    }],
  }, 18, {
    async listImmutableReferences() { return [reference]; },
    async readAdmissionRecord(selected) {
      assert.equal(selected, reference);
      return record;
    },
    async fetchBlob() { throw new Error("unused"); },
    async fetchManifest() { throw new Error("unused"); },
    async fetchCanonicalOci() { throw new Error("unused"); },
  }, async () => { validated++; }, async (recordBytes) => {
    assert.equal(sha256(recordBytes), projection.admission_record_sha256);
    projected++;
    return projection;
  });
  assert.equal(admissions[0]!.immutable_reference, reference);
  assert.equal(admissions[0]!.record_sha256, sha256(canonicalJsonBytes(record)));
  assert.notEqual(admissions[0]!.record_sha256, manifestSha256);
  assert.equal(validated, 1);
  assert.equal(projected, 1);
  assert.deepEqual((admissions[0] as any).projection, projection);
});

test("rejects a selected admission without a current-main projection", async () => {
  const repository = "ghcr.io/kandelo-dev/homebrew-tap-core-abi-18/dash/admissions";
  const reference = `${repository}@sha256:${"a".repeat(64)}`;
  const record = {
    admission: {
      formula_metadata_update: { architecture: "wasm32", formula: "dash", target_abi: 18 },
      promoted_layer: { bytes: 12, sha256: "b".repeat(64) },
    },
    kind: "kandelo-abi-staging-admission",
    schema: 1,
  };
  await assert.rejects(
    () => discoverAdmissions({
      inputs: [{
        bytes: 12,
        id: "homebrew-dash",
        kind: "homebrew-bottle",
        sha256: "b".repeat(64),
      }],
    }, 18, {
      async listImmutableReferences() { return [reference]; },
      async readAdmissionRecord() { return record; },
      async fetchBlob() { throw new Error("unused"); },
      async fetchManifest() { throw new Error("unused"); },
      async fetchCanonicalOci() { throw new Error("unused"); },
    }, async () => undefined, async () => undefined as any),
    /current.*projection/i,
  );
});

test("selects a deterministic admission when equivalent immutable history coexists", async () => {
  const references = ["a", "b"].map((suffix, index) =>
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-18/dash/admissions@sha256:` +
    `${String(index + 1).repeat(64)}`);
  const base = {
    admission: {
      canonical: {
        bytes: 99,
        immutable_reference:
          `ghcr.io/kandelo-dev/homebrew-tap-core-abi-18/dash@sha256:${"c".repeat(64)}`,
        sha256: "c".repeat(64),
      },
      formula_metadata_update: {
        bottle_layer_bytes: 12,
        bottle_layer_sha256: "b".repeat(64),
        canonical_manifest_digest: "c".repeat(64),
        architecture: "wasm32",
        formula: "dash",
        target_abi: 18,
      },
      promoted_layer: { bytes: 12, sha256: "b".repeat(64) },
    },
    kind: "kandelo-abi-staging-admission",
    schema: 1,
  };
  const records = references.map((_reference, index) => ({
    ...structuredClone(base),
    historical_run: index + 1,
  }));
  let validated = 0;
  const admissions = await discoverAdmissions({
    inputs: [{
      bytes: 12,
      id: "homebrew-dash",
      kind: "homebrew-bottle",
      sha256: "b".repeat(64),
    }],
  }, 18, {
    async listImmutableReferences() { return [...references].reverse(); },
    async readAdmissionRecord(reference) { return records[references.indexOf(reference)]!; },
    async fetchBlob() { throw new Error("unused"); },
    async fetchManifest() { throw new Error("unused"); },
    async fetchCanonicalOci() { throw new Error("unused"); },
  }, async () => { validated++; }, async (recordBytes) => ({
    admission_record_sha256: sha256(recordBytes),
    architecture: "wasm32",
    formula: "dash",
    formula_metadata_update_sha256: sha256(canonicalJsonBytes(
      (records[0] as any).admission.formula_metadata_update,
    )),
    kind: "kandelo-pages-admission-projection",
    projection_sha256: "d".repeat(64),
    schema: 1,
    tap_source: {
      commit: "4".repeat(40),
      repository: "kandelo-dev/homebrew-tap-core",
      tree: "5".repeat(40),
    },
    target_abi: 18,
  }));
  const expected = records.map((record, index) => ({
    recordSha256: sha256(canonicalJsonBytes(record)),
    reference: references[index]!,
  })).sort((left, right) => left.recordSha256.localeCompare(right.recordSha256))[0]!;
  assert.equal(admissions[0]!.record_sha256, expected.recordSha256);
  assert.equal(admissions[0]!.immutable_reference, expected.reference);
  assert.equal(validated, 2);
});

test("binds exact current projections into readiness and rejects cross-product conflicts", () => {
  const tapSource = {
    commit: "4".repeat(40),
    repository: "kandelo-dev/homebrew-tap-core",
    tree: "5".repeat(40),
  };
  const admission = {
    immutable_reference: `ghcr.io/example/admission@sha256:${"a".repeat(64)}`,
    record_sha256: "b".repeat(64),
  };
  const projection = {
    admission_record_sha256: admission.record_sha256,
    architecture: "wasm32",
    formula: "dash",
    formula_metadata_update_sha256: "c".repeat(64),
    kind: "kandelo-pages-admission-projection",
    projection_sha256: "d".repeat(64),
    schema: 1,
    tap_source: tapSource,
    target_abi: 18,
  };
  const result: any = {
    readiness: {
      products: [{ admissions: [structuredClone(admission)], id: "shell" }],
      ready: true,
    },
    site_manifest: {
      products: [{ admissions: [structuredClone(admission)], id: "shell" }],
      readiness_record_sha256: "e".repeat(64),
    },
  };
  bindAdmissionProjections(result, [{
    admissions: [{ ...admission, projection }],
    id: "shell",
  }] as any, tapSource);
  assert.deepEqual(result.readiness.tap_source, tapSource);
  assert.deepEqual(result.readiness.products[0].admissions[0].projection, projection);
  assert.deepEqual(result.site_manifest.tap_source, tapSource);
  assert.deepEqual(result.site_manifest.products[0].admissions,
    result.readiness.products[0].admissions);
  assert.equal(result.site_manifest.readiness_record_sha256,
    sha256(canonicalJsonBytes(result.readiness)));

  const conflictResult: any = {
    readiness: {
      products: ["one", "two"].map((id) => ({
        admissions: [structuredClone(admission)], id,
      })),
      ready: true,
    },
    site_manifest: {
      products: ["one", "two"].map((id) => ({
        admissions: [structuredClone(admission)], id,
      })),
      readiness_record_sha256: "e".repeat(64),
    },
  };
  assert.throws(() => bindAdmissionProjections(conflictResult, [{
    admissions: [{ ...admission, projection }],
    id: "one",
  }, {
    admissions: [{
      ...admission,
      projection: { ...projection, projection_sha256: "f".repeat(64) },
    }],
    id: "two",
  }] as any, tapSource), /conflicting current projections/i);
});

test("derives site and gallery identities from protected current outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-site-metadata-"));
  try {
    mkdirSync(join(root, "api"));
    mkdirSync(join(root, "guide"));
    writeFileSync(join(root, "index.html"), "browser\n");
    writeFileSync(join(root, "api/index.html"), "api\n");
    writeFileSync(join(root, "guide/index.html"), "docs\n");
    const metadata = derivePagesSiteMetadata(root, {
      kind: "kandelo-pages-vfs-products",
      products: [{ id: "mini", load: "eager" }],
      schema: 1,
    }, {
      kind: "kandelo-pages-vfs-product-gallery",
      products: [{ gallery_entries: ["shell"], id: "mini", vfs_image: "shell" }],
      schema: 1,
    }, `export const PRESET_LIBRARY = [\n    id: "shell",\n];\n`,
    `const LIVE_DEMO_SPECS = {\n  shell: {\n    image: "shell",\n  },\n};\n`);
    assert.deepEqual(metadata.products, [{
      gallery_entries: ["shell"], id: "mini", vfs_image: "shell",
    }]);
    assert.deepEqual(metadata.files.map((file: any) => file.path), [
      "api/index.html", "guide/index.html", "index.html",
    ]);
    assert.deepEqual(metadata.browser, metadata.files[2]);
    assert.deepEqual(metadata.documentation, metadata.files[1]);
    assert.deepEqual(metadata.api, metadata.files[0]);

    assert.throws(
      () => derivePagesSiteMetadata(root, {
        kind: "kandelo-pages-vfs-products",
        products: [{ id: "mini", load: "eager" }],
        schema: 1,
      }, {
        kind: "kandelo-pages-vfs-product-gallery",
        products: [{ gallery_entries: ["shell"], id: "mini", vfs_image: "node" }],
        schema: 1,
      }, `export const PRESET_LIBRARY = [\n    id: "shell",\n];\n`,
      `const LIVE_DEMO_SPECS = {\n  shell: {\n    image: "shell",\n  },\n};\n`),
      /reviewed VFS image/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("runs production orchestration through ready and atomic hold-only outcomes", async (t) => {
  for (const scenario of [
    "ready",
    "missing-product",
    "missing-admission",
    "builder-failure",
    "evidence-failure",
    "evidence-timeout",
    "postflight-failure",
  ] as const) {
    await t.test(scenario, async () => {
      const root = mkdtempSync(join(tmpdir(), `kandelo-pages-producer-${scenario}-`));
      try {
        const fixture = await createMiniaturePagesProducerFixture(root, scenario);
        if (scenario === "postflight-failure") {
          await assert.rejects(
            () => producePagesArtifacts(
              fixture.handoffPath,
              fixture.outputRoot,
              fixture.oci,
              fixture.dependencies,
            ),
            /final source re-observation failure/i,
          );
          assert.equal(existsSync(fixture.outputRoot), false);
          assert.deepEqual(
            readdirSync(root).filter((name) => name.includes(".staging-")),
            [],
          );
          return;
        }
        await producePagesArtifacts(
          fixture.handoffPath,
          fixture.outputRoot,
          fixture.oci,
          fixture.dependencies,
        );
        const readiness = JSON.parse(readFileSync(
          join(fixture.outputRoot, "readiness.json"),
          "utf8",
        ));
        if (scenario === "ready") {
          assert.equal(readiness.ready, true, JSON.stringify(readiness.blockers));
          assert.ok(existsSync(join(fixture.outputRoot, "site-manifest.json")));
          assert.ok(existsSync(join(fixture.outputRoot, "source-tree")));
          const resolved = JSON.parse(readFileSync(
            join(
              fixture.outputRoot,
              "artifacts/products/base/resolved-inputs.json",
            ),
            "utf8",
          ));
          assert.equal(resolved.inputs[0].reference, undefined);
          assert.match(resolved.inputs[1].reference, /\/products\/inputs\//u);
          const childResolved = JSON.parse(readFileSync(
            join(
              fixture.outputRoot,
              "artifacts/products/mini/resolved-inputs.json",
            ),
            "utf8",
          ));
          assert.match(
            childResolved.inputs[0].reference,
            /\/products\/base\/sha256-[0-9a-f]{64}\/base-18\.vfs\.zst\?sha256=/u,
          );
          assert.equal(childResolved.inputs[0].effective_materialization, "embedded");
          assert.deepEqual(
            readiness.products.map(({ id }: { id: string }) => id),
            ["base", "mini"],
          );
        } else {
          assert.equal(readiness.ready, false);
          assert.deepEqual(readdirSync(fixture.outputRoot), ["readiness.json"]);
          assert.ok(readiness.blockers.length >= 1);
        }
        assert.deepEqual(
          readdirSync(root).filter((name) => name.includes(".staging-")),
          [],
        );
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
});

function currentInventoryForFixture(
  fixture: ReturnType<typeof candidateOciFixture>,
  inventorySource = source,
) {
  return {
    build_environment: fixture.resolved.build_environment,
    kind: "kandelo-vfs-product-input-object-inventory",
    objects: fixture.resolved.inputs.map((input) => ({
      ...input,
      adapter: "package-output-file-v1",
      path: `inputs/objects/${input.id}`,
    })),
    product: Object.fromEntries(
      Object.entries(fixture.resolved.product).filter(([key]) => key !== "output"),
    ),
    schema: 1,
    source: inventorySource,
    target_abi: targetAbi,
  };
}

function candidateOciFixture(
  fixtureSource = source,
  repositoryBundle?: Uint8Array,
  repositoryPaths: string[] = ["selected"],
) {
  const repository = "ghcr.io/kandelo-dev/homebrew-tap-core-abi-18-candidates/products/mini";
  const embedded = new TextEncoder().encode("embedded package\n");
  const lazy = new TextEncoder().encode("lazy package\n");
  const resolved = {
    build_environment: {
      dev_shell_lock_sha256: "5".repeat(64),
      policy_sha256: "6".repeat(64),
    },
    inputs: [
      {
        architecture: "wasm32",
        bytes: embedded.byteLength,
        declared_materialization: "embedded",
        effective_materialization: "embedded",
        id: "package-runtime-output-runtime",
        kind: "package-output",
        path: "inputs/objects/package-runtime-output-runtime",
        reference: `https://example.invalid/runtime?sha256=${sha256(embedded)}`,
        role: "runtime",
        sha256: sha256(embedded),
      },
      {
        architecture: "wasm32",
        bytes: lazy.byteLength,
        declared_materialization: "lazy",
        effective_materialization: "lazy-reference",
        id: "package-tool-output-tool",
        kind: "package-output",
        reference: `${repository}@sha256:${sha256(lazy)}`,
        role: "runtime",
        sha256: sha256(lazy),
      },
      ...(repositoryBundle === undefined
        ? []
        : [{
          architecture: "wasm32",
          bytes: repositoryBundle.byteLength,
          declared_materialization: "embedded",
          effective_materialization: "embedded",
          id: "repository-rootfs-source",
          kind: "repository-path",
          path: "inputs/objects/repository-rootfs-source",
          reference:
            `${repository}@sha256:${sha256(repositoryBundle)}`,
          repository_id: "rootfs-source",
          paths: repositoryPaths,
          role: "runtime",
          sha256: sha256(repositoryBundle),
        }]),
    ],
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: "wasm32",
      id: "mini",
      manifest_path: "images/vfs/products/mini.toml",
      manifest_sha256: "7".repeat(64),
      output: "mini.vfs.zst",
    },
    reference_class: "candidate",
    schema: 1,
    source: fixtureSource,
    target_abi: targetAbi,
  };
  const vfsSha256 = repositoryBundle === undefined
    ? "8".repeat(64)
    : sha256(repositoryBundle);
  const report = {
    capture: { complete: true, unreported_reads: [] },
    inputs: resolved.inputs.map(({ bytes, id, kind, role, effective_materialization }) => ({
      bytes,
      id,
      kind,
      placement: effective_materialization,
      role,
      sha256: resolved.inputs.find((input) => input.id === id)!.sha256,
    })),
    kind: "kandelo-vfs-builder-report",
    output: {
      abi: targetAbi,
      bytes: 99,
      name: "mini.vfs.zst",
      path: "mini.vfs.zst",
      sha256: vfsSha256,
    },
    product: resolved.product,
    resolved_inputs_sha256: sha256(canonicalJsonBytes(resolved)),
    schema: 1,
  };
  const runtime = canonicalJsonBytes({
    exact: "runtime",
    source: fixtureSource,
    target_abi: targetAbi,
  });
  const reportBytes = canonicalJsonBytes(report);
  const resolvedBytes = canonicalJsonBytes(resolved);
  const artifacts = {
    builder_report: artifact(repository, reportBytes),
    lazy_inputs: [{
      bytes: lazy.byteLength,
      id: "package-tool-output-tool",
      immutable_reference: `${repository}@sha256:${sha256(lazy)}`,
      kind: "package-output",
      sha256: sha256(lazy),
    }],
    resolved_inputs: artifact(repository, resolvedBytes),
    runtime_bundle: artifact(repository, runtime),
    vfs_image: {
      bytes: 99,
      immutable_reference: `${repository}@sha256:${vfsSha256}`,
      sha256: vfsSha256,
    },
  };
  const config = canonicalJsonBytes({
    artifacts,
    kind: "kandelo-vfs-candidate-product",
    nonendorsed: true,
    product: resolved.product,
    reference_class: "candidate",
    schema: 1,
    source: fixtureSource,
    target_abi: targetAbi,
  });
  const descriptors = [
    descriptor("candidate-product-record", "candidate-product-record.json",
      "application/vnd.kandelo.abi-staging.product.candidate.v1+json", config),
    {
      annotations: {
        "dev.kandelo.abi-staging.role": "vfs-image",
        "org.opencontainers.image.title": "mini.vfs.zst",
      },
      digest: `sha256:${vfsSha256}`,
      mediaType: "application/vnd.kandelo.vfs.image.v1",
      size: 99,
    },
    descriptor("builder-report", "builder-report.json",
      "application/vnd.kandelo.vfs.builder-report.v1+json", reportBytes),
    descriptor("resolved-inputs", "resolved-inputs.json",
      "application/vnd.kandelo.vfs.resolved-inputs.v1+json", resolvedBytes),
    descriptor("runtime-bundle", "runtime-bundle.json",
      "application/vnd.kandelo.abi-staging.runtime-bundle.v1+json", runtime),
    descriptor("lazy-input-0000", "lazy-input-package-tool-output-tool",
      "application/vnd.kandelo.vfs.lazy-input.v1", lazy),
  ];
  const manifest = canonicalJsonBytes({
    annotations: {
      "dev.kandelo.abi-staging.architecture": "wasm32",
      "dev.kandelo.abi-staging.classification": "public-candidate-not-endorsed",
      "dev.kandelo.abi-staging.kind": "candidate-product",
      "dev.kandelo.abi-staging.nonendorsed": "true",
      "dev.kandelo.abi-staging.product": "mini",
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
    [`sha256:${sha256(config)}`, config],
    [`sha256:${sha256(reportBytes)}`, reportBytes],
    [`sha256:${sha256(resolvedBytes)}`, resolvedBytes],
    [`sha256:${sha256(runtime)}`, runtime],
    [`sha256:${sha256(lazy)}`, lazy],
  ]);
  return {
    blobs,
    manifest,
    reference: `${repository}@sha256:${sha256(manifest)}`,
    report,
    resolved,
    vfsSha256,
  };
}

function artifact(repository: string, body: Uint8Array) {
  return {
    bytes: body.byteLength,
    immutable_reference: `${repository}@sha256:${sha256(body)}`,
    sha256: sha256(body),
  };
}

function descriptor(role: string, title: string, mediaType: string, body: Uint8Array) {
  return {
    annotations: {
      "dev.kandelo.abi-staging.role": role,
      "org.opencontainers.image.title": title,
    },
    digest: `sha256:${sha256(body)}`,
    mediaType,
    size: body.byteLength,
  };
}
