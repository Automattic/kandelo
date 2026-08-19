import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { ABI_VERSION } from "../host/src/generated/abi.ts";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs.ts";
import { createRepositoryPathBundle } from "../images/vfs/scripts/repository-path-bundle.ts";
import * as pagesProducer from "./abi-staging-pages-producer.ts";

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
  isAbsentPublicPagesRecordTagInventory,
  isExpectedCurrentInputUnavailable,
  producePagesArtifacts,
  readCandidateProductAuthority,
  rebuildCurrentResolvedInputs,
  shipPagesArtifacts,
  validateCandidateProductReference,
  validatePagesProductionHandoff,
  writeAtomicHoldOnlyOutput,
} from "./abi-staging-pages-producer.ts";
import { createMiniaturePagesProducerFixture } from "./abi-staging-pages-producer-fixture.ts";
import {
  buildFinalPagesSite,
  loadCanonicalPagesProductMap,
} from "./abi-staging-pages-site-builder.ts";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const source = {
  repository: "Automattic/kandelo",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
};
const targetAbi = { version: 18, snapshot_sha256: "3".repeat(64) };

test("treats only anonymously absent Pages record repositories as empty", () => {
  const repository =
    "ghcr.io/kandelo-dev/homebrew-tap-core-abi-43/dash/admissions";
  assert.equal(
    isAbsentPublicPagesRecordTagInventory(
      repository,
      new Error(
        "OCI tag inventory anonymous read failed: Error response from registry: " +
        "denied: requested access to the resource is denied\n",
      ),
    ),
    true,
  );
  assert.equal(
    isAbsentPublicPagesRecordTagInventory(
      "ghcr.io/kandelo-dev/homebrew-tap-core-abi-43-candidates/products/browser-main-shell",
      new Error(
        "OCI tag inventory anonymous read failed: Error response from registry: " +
        "denied: requested access to the resource is denied\n",
      ),
    ),
    true,
  );
  assert.equal(
    isAbsentPublicPagesRecordTagInventory(
      "ghcr.io/kandelo-dev/homebrew-tap-core-abi-43-candidates/dash",
      new Error(
        "OCI tag inventory anonymous read failed: Error response from registry: " +
        "denied: requested access to the resource is denied\n",
      ),
    ),
    false,
  );
  assert.equal(
    isAbsentPublicPagesRecordTagInventory(
      repository,
      new Error("OCI tag inventory anonymous read failed: request timed out"),
    ),
    false,
  );
});
const assembledTargetAbi = {
  version: ABI_VERSION,
  snapshot_sha256: sha256(
    readFileSync(new URL("../abi/snapshot.json", import.meta.url)),
  ),
};

test("serves exact local lazy bytes under their canonical transport identity", async () => {
  const body = new TextEncoder().encode("current canonical lazy bytes\n");
  const digest = sha256(body);
  const url =
    `https://automattic.github.io/kandelo/products/inputs/package-dash/` +
    `sha256-${digest}/package-dash?sha256=${digest}&bytes=${body.byteLength}`;
  const factory = createLocalLazyFetcher(
    new Map([[url, { body, bytes: body.byteLength, sha256: digest }]]),
  );
  const fetchLazy = factory([
    { url, sourceUrl: url, sha256: digest, size: body.byteLength },
  ]);
  const response = await fetchLazy(url);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
  await assert.rejects(
    () => fetchLazy(`${url}&hostile=1`),
    /closed local lazy transport/i,
  );
  assert.throws(
    () =>
      factory([
        { url, sourceUrl: url, sha256: "f".repeat(64), size: body.byteLength },
      ]),
    /differs from its exact body/i,
  );
});

test("re-observes exact clean source identity after protected execution", () => {
  let clean = true;
  let observations = 0;
  const reobserve = createExactSourceReobserver(
    {
    commit: source.commit,
    devShellLockSha256: "4".repeat(64),
    root: "/protected/source",
    tree: source.tree,
    },
    () => {
    observations++;
    if (!clean) throw new Error("exact source checkout has tracked mutation");
    },
  );
  clean = false;
  assert.throws(reobserve, /tracked mutation/i);
  assert.equal(observations, 2);
});

test("emits canonical hold-only readiness for expected product incompleteness", () => {
  const readiness = heldPagesReadinessRecord({
    blockers: [
      {
      detail: "mini has no immutable current-tree candidate",
      kind: "candidate-input-missing",
      product_id: "mini",
      },
    ],
    pagesRegistry: {
      path: "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
      products: [{ id: "mini", load: "eager" }],
      sha256: "5".repeat(64),
    },
    source,
    tapSource: {
      commit: "4".repeat(40),
      repository: "kandelo-dev/homebrew-tap-core",
      tree: "5".repeat(40),
    },
    targetAbi,
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.site_metadata_sha256, null);
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
    writeFileSync(
      join(staging, "current-inputs", "unpublished.bin"),
      "private\n",
    );
    writeAtomicHoldOnlyOutput(staging, output, { ready: false });
    assert.deepEqual(readdirSync(output), ["readiness.json"]);
    assert.equal(existsSync(staging), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("holds only for absent current artifacts and rejects protected identity drift", () => {
  const missing = Object.assign(new Error("package root is unavailable"), {
    code: "ENOENT",
  });
  assert.equal(isExpectedCurrentInputUnavailable(missing), true);
  assert.equal(
    isExpectedCurrentInputUnavailable(
      new Error(
        "current-main source tree differs from the candidate-proven source tree",
      ),
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
  assert.equal(
    authenticated.lazyInputs.get("package-tool-output-tool")?.sha256,
    fixture.resolved.inputs[1]!.sha256,
  );
  assert.equal(fetched.includes(`sha256:${fixture.vfsSha256}`), false);
  assert.equal(
    fetched.includes(`sha256:${fixture.resolved.inputs[1]!.sha256}`),
    false,
  );
});

test("rejects dotted product reference confusion and oversized candidate descriptors", async () => {
  assert.throws(
    () =>
      validateCandidateProductReference(
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
    () =>
      readCandidateProductAuthority(
        reference,
        {
      productId: "mini",
      source,
      targetAbi,
        },
        {
          async fetchManifest() {
            return manifestBytes;
          },
      async fetchBlob(_repository, digest) {
        const body = fixture.blobs.get(digest);
        if (body === undefined) {
              throw new Error(
                "oversized descriptor must fail before its blob read",
              );
        }
        return body;
      },
        },
      ),
    /byte bound/,
  );
});

test("rejects a self-consistent candidate under-inventory against current main collection", () => {
  const fixture = candidateOciFixture();
  const inventory = {
    schema: 1,
    kind: "kandelo-vfs-product-input-object-inventory",
    product: Object.fromEntries(
      Object.entries(fixture.resolved.product).filter(
        ([key]) => key !== "output",
      ),
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
  const root = mkdtempSync(
    join(tmpdir(), "kandelo-pages-repository-recapture-"),
  );
  try {
    mkdirSync(join(root, "selected"));
    writeFileSync(join(root, "selected", "config.json"), '{"current":true}\n');
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
    assert.equal(
      recaptured.path,
      "inputs/objects/repository-rootfs-source-current",
    );
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
    products: [
      {
      current_inputs: {
        archive_files: "/tmp/archive-files.json",
        program_index: "/tmp/program-index.json",
      },
      id: "mini",
      },
    ],
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
    () =>
      validatePagesProductionHandoff({
        ...handoff,
        products: [{
          ...handoff.products[0],
          current_inputs: {
            ...handoff.products[0].current_inputs,
            package_roots: "/tmp/package-roots.json",
          },
        }],
      }),
    /fields differ/u,
  );
  assert.throws(
    () =>
      validatePagesProductionHandoff({
      ...handoff,
      tap_source: { ...tapSource, repository: "example/homebrew-tap-core" },
    }),
    /tap source/i,
  );
  assert.throws(
    () =>
      validatePagesProductionHandoff({
      ...handoff,
        products: [
          { ...handoff.products[0], candidate_vfs: "/tmp/candidate.vfs" },
        ],
    }),
    /fields differ/,
  );
  assert.throws(
    () =>
      validatePagesProductionHandoff({
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
    () =>
      validatePagesProductionHandoff({
      ...handoff,
      site_metadata: "/tmp/self-authorized.json",
    }),
    /fields differ/,
  );
});

test("reads a direct canonical bottle without admission records", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-direct-bottle-"));
  const formula = "nginx";
  const abi = 43;
  const bottle = new TextEncoder().encode("direct canonical bottle\n");
  const metadata = new TextEncoder().encode("{}\n");
  const composition = new TextEncoder().encode('{"schema":1}\n');
  const bottleSha = sha256(bottle);
  const metadataSha = sha256(metadata);
  const compositionSha = sha256(composition);
  const repository = `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${abi}/${formula}`;
  const layer = (role: string, body: Uint8Array) => ({
    annotations: { "dev.kandelo.abi-staging.role": role },
    digest: `sha256:${sha256(body)}`,
    mediaType: "application/octet-stream",
    size: body.byteLength,
  });
  const config = canonicalJsonBytes({
    bottle_layer: { bytes: bottle.byteLength, sha256: bottleSha },
    bottle_metadata: { bytes: metadata.byteLength, sha256: metadataSha },
    candidate_record_sha256: "c".repeat(64),
    classification: "canonical-direct",
    formula: {
      architecture: "wasm32",
      name: formula,
      tap: "kandelo-dev/homebrew-tap-core",
      target_abi: abi,
    },
    kind: "kandelo-homebrew-canonical-bottle",
    request_sha256: "e".repeat(64),
    schema: 1,
    source: {
      commit: "f".repeat(40),
      repository: "Automattic/kandelo",
      tree: "a".repeat(40),
    },
    vfs_composition_descriptor: {
      bytes: composition.byteLength,
      sha256: compositionSha,
    },
  });
  const manifest = canonicalJsonBytes({
    annotations: {
      "dev.kandelo.abi-staging.formula": formula,
      "dev.kandelo.abi-staging.target-abi": String(abi),
    },
    artifactType: "application/vnd.kandelo.homebrew.canonical-bottle.v1+json",
    config: {
      annotations: {
        "dev.kandelo.abi-staging.role": "canonical-bottle-metadata",
        "org.opencontainers.image.title": "canonical-bottle.json",
      },
      digest: `sha256:${sha256(config)}`,
      mediaType: "application/vnd.kandelo.homebrew.canonical-bottle.v1+json",
      size: config.byteLength,
    },
    layers: [
      layer("bottle-layer", bottle),
      layer("bottle-metadata", metadata),
      layer("vfs-composition-descriptor", composition),
    ],
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  const manifestSha = sha256(manifest);
  const reference = `${repository}@sha256:${manifestSha}`;
  try {
    mkdirSync(join(root, "Formula"));
    mkdirSync(join(root, "Kandelo/formula"), { recursive: true });
    writeFileSync(join(root, `Formula/${formula}.rb`), [
      "class Nginx < Formula",
      "  bottle do",
      `    root_url "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-${abi}/${formula}"`,
      `    sha256 cellar: "/opt/kandelo/homebrew/Cellar", wasm32_kandelo: "${bottleSha}"`,
      "  end",
      "end",
      "",
    ].join("\n"));
    writeFileSync(join(root, `Kandelo/formula/${formula}.json`), canonicalJsonBytes({
      bottle_rebuild: 0,
      bottles: [{
        arch: "wasm32",
        bottle_tag: "wasm32_kandelo",
        bytes: bottle.byteLength,
        cache_key_sha: bottleSha,
        cellar: "/opt/kandelo/homebrew/Cellar",
        kandelo_abi: abi,
        prefix: "/opt/kandelo/homebrew",
        sha256: bottleSha,
        status: "success",
        url: `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-${abi}/${formula}/blobs/sha256:${bottleSha}`,
      }],
      formula_path: `Formula/${formula}.rb`,
      full_name: `kandelo-dev/tap-core/${formula}`,
      kandelo_abi: abi,
      name: formula,
      schema: 1,
    }));
    const authority = {
        async fetchBlob(selected: string, digest: string, bytes: number) {
          assert.equal(selected, repository);
          assert.equal(digest, `sha256:${sha256(config)}`);
          assert.equal(bytes, config.byteLength);
          return config;
        },
        async fetchCanonicalOci(selected: string) {
          assert.equal(selected, reference);
          return {
            bottle_layer: bottle,
            bottle_metadata: metadata,
            config,
            manifest,
            vfs_composition_descriptor: composition,
          };
        },
        async fetchManifest(selected: string) {
          assert.equal(selected, reference);
          return manifest;
        },
        async listImmutableReferences() {
          throw new Error("direct bottle must not list admission records");
        },
        async listTags(selected: string) {
          assert.equal(selected, repository);
          return [`canonical-sha256-${manifestSha}`];
        },
        async readAdmissionRecord() {
          throw new Error("direct bottle must not read admission records");
        },
      };
    const result = await pagesProducer.readDirectCanonicalBottle(
      formula,
      abi,
      root,
      authority,
    );
    assert.equal(result.layer.sha256, bottleSha);
    assert.equal(result.layer.bytes, bottle.byteLength);
    assert.equal(result.descriptor.sha256, compositionSha);
    assert.equal(result.descriptor.bytes, composition.byteLength);
    assert.notEqual(metadataSha, compositionSha);
    const formulaList = join(root, "formula-list.txt");
    writeFileSync(formulaList, `${formula}\n`);
    const closure = await (pagesProducer as any).preflightPagesBottleClosure(
      root,
      abi,
      formulaList,
      authority,
    );
    assert.deepEqual(closure.map((entry: any) => entry.formula), [formula]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("discovers one immutable current-tree candidate without caller locators", async () => {
  const fixture = candidateOciFixture();
  const repository = fixture.reference.split("@", 1)[0]!;
  const discovered = await discoverCandidateProductAuthority(
    {
    productId: "mini",
    source,
    targetAbi,
    },
    {
    async listImmutableReferences(selected) {
      assert.equal(selected, repository);
      return [fixture.reference];
    },
      async fetchManifest() {
        return fixture.manifest;
      },
    async fetchBlob(_repository, digest) {
      const body = fixture.blobs.get(digest);
      assert.ok(body);
      return body;
    },
    },
  );
  assert.equal(discovered.reference, fixture.reference);
  assert.equal(discovered.authority.candidateRecord.product.id, "mini");
});

test("selects a deterministic equivalent candidate when same-tree history coexists", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-candidate-history-"));
  try {
    mkdirSync(join(root, "selected"));
    writeFileSync(join(root, "selected", "config.json"), '{"sameTree":true}\n');
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
    const discovered = await discoverCandidateProductAuthority(
      {
      productId: "mini",
      source,
      targetAbi,
      },
      {
        async listImmutableReferences() {
          return [second.reference, first.reference];
        },
        async fetchManifest(reference) {
          return fixtures.get(reference)!.manifest;
        },
      async fetchBlob(_repository, digest) {
        for (const fixture of fixtures.values()) {
          const body = fixture.blobs.get(digest);
          if (body !== undefined) return body;
        }
        throw new Error(`unexpected blob ${digest}`);
      },
      },
    );
    assert.equal(
      discovered.reference,
      [first.reference, second.reference].sort()[0],
    );
    await assert.rejects(
      () =>
        discoverCandidateProductAuthority(
          {
        productId: "mini",
        source,
        targetAbi,
          },
          {
            async listImmutableReferences() {
              return [first.reference, conflict.reference];
            },
            async fetchManifest(reference) {
              return fixtures.get(reference)!.manifest;
            },
        async fetchBlob(_repository, digest) {
          for (const fixture of fixtures.values()) {
            const body = fixture.blobs.get(digest);
            if (body !== undefined) return body;
          }
          throw new Error(`unexpected blob ${digest}`);
        },
          },
        ),
      /conflicting immutable current-tree records/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("preserves the authenticated admission manifest locator independently of record bytes", async () => {
  const manifestSha256 = "a".repeat(64);
  const repository =
    "ghcr.io/kandelo-dev/homebrew-tap-core-abi-18/dash/admissions";
  const [reference] = immutableRecordReferencesFromTags(repository, [
    `record-sha256-${manifestSha256}`,
  ]);
  const record = {
    admission: {
      formula_metadata_update: {
        architecture: "wasm32",
        formula: "dash",
        target_abi: 18,
      },
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
    formula_metadata_update_sha256: sha256(
      canonicalJsonBytes(record.admission.formula_metadata_update),
    ),
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
  const admissions = await discoverAdmissions(
    {
      inputs: [
        {
      bytes: 12,
      id: "homebrew-dash",
      kind: "homebrew-bottle",
      sha256: "b".repeat(64),
        },
      ],
    },
    18,
    {
      async listImmutableReferences() {
        return [reference];
      },
    async readAdmissionRecord(selected) {
      assert.equal(selected, reference);
      return record;
    },
      async fetchBlob() {
        throw new Error("unused");
      },
      async fetchManifest() {
        throw new Error("unused");
      },
      async fetchCanonicalOci() {
        throw new Error("unused");
      },
    },
    async () => {
      validated++;
    },
    async (recordBytes) => {
    assert.equal(sha256(recordBytes), projection.admission_record_sha256);
    projected++;
    return projection;
    },
  );
  assert.equal(admissions[0]!.immutable_reference, reference);
  assert.equal(
    admissions[0]!.record_sha256,
    sha256(canonicalJsonBytes(record)),
  );
  assert.notEqual(admissions[0]!.record_sha256, manifestSha256);
  assert.equal(validated, 1);
  assert.equal(projected, 1);
  assert.deepEqual((admissions[0] as any).projection, projection);
});

test("rejects a selected admission without a current-main projection", async () => {
  const repository =
    "ghcr.io/kandelo-dev/homebrew-tap-core-abi-18/dash/admissions";
  const reference = `${repository}@sha256:${"a".repeat(64)}`;
  const record = {
    admission: {
      formula_metadata_update: {
        architecture: "wasm32",
        formula: "dash",
        target_abi: 18,
      },
      promoted_layer: { bytes: 12, sha256: "b".repeat(64) },
    },
    kind: "kandelo-abi-staging-admission",
    schema: 1,
  };
  await assert.rejects(
    () =>
      discoverAdmissions(
        {
          inputs: [
            {
        bytes: 12,
        id: "homebrew-dash",
        kind: "homebrew-bottle",
        sha256: "b".repeat(64),
            },
          ],
        },
        18,
        {
          async listImmutableReferences() {
            return [reference];
          },
          async readAdmissionRecord() {
            return record;
          },
          async fetchBlob() {
            throw new Error("unused");
          },
          async fetchManifest() {
            throw new Error("unused");
          },
          async fetchCanonicalOci() {
            throw new Error("unused");
          },
        },
        async () => undefined,
        async () => undefined as any,
      ),
    /current.*projection/i,
  );
});

test("selects a deterministic admission when equivalent immutable history coexists", async () => {
  const references = ["a", "b"].map(
    (suffix, index) =>
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-18/dash/admissions@sha256:` +
      `${String(index + 1).repeat(64)}`,
  );
  const base = {
    admission: {
      canonical: {
        bytes: 99,
        immutable_reference: `ghcr.io/kandelo-dev/homebrew-tap-core-abi-18/dash@sha256:${"c".repeat(64)}`,
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
  const admissions = await discoverAdmissions(
    {
      inputs: [
        {
      bytes: 12,
      id: "homebrew-dash",
      kind: "homebrew-bottle",
      sha256: "b".repeat(64),
        },
      ],
    },
    18,
    {
      async listImmutableReferences() {
        return [...references].reverse();
      },
      async readAdmissionRecord(reference) {
        return records[references.indexOf(reference)]!;
      },
      async fetchBlob() {
        throw new Error("unused");
      },
      async fetchManifest() {
        throw new Error("unused");
      },
      async fetchCanonicalOci() {
        throw new Error("unused");
      },
    },
    async () => {
      validated++;
    },
    async (recordBytes) => ({
    admission_record_sha256: sha256(recordBytes),
    architecture: "wasm32",
    formula: "dash",
      formula_metadata_update_sha256: sha256(
        canonicalJsonBytes(
      (records[0] as any).admission.formula_metadata_update,
        ),
      ),
    kind: "kandelo-pages-admission-projection",
    projection_sha256: "d".repeat(64),
    schema: 1,
    tap_source: {
      commit: "4".repeat(40),
      repository: "kandelo-dev/homebrew-tap-core",
      tree: "5".repeat(40),
    },
    target_abi: 18,
    }),
  );
  const expected = records
    .map((record, index) => ({
    recordSha256: sha256(canonicalJsonBytes(record)),
    reference: references[index]!,
    }))
    .sort((left, right) =>
      left.recordSha256.localeCompare(right.recordSha256),
    )[0]!;
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
  bindAdmissionProjections(
    result,
    [
      {
    admissions: [{ ...admission, projection }],
    id: "shell",
      },
    ] as any,
    tapSource,
  );
  assert.deepEqual(result.readiness.tap_source, tapSource);
  assert.deepEqual(
    result.readiness.products[0].admissions[0].projection,
    projection,
  );
  assert.deepEqual(result.site_manifest.tap_source, tapSource);
  assert.deepEqual(
    result.site_manifest.products[0].admissions,
    result.readiness.products[0].admissions,
  );
  assert.equal(
    result.site_manifest.readiness_record_sha256,
    sha256(canonicalJsonBytes(result.readiness)),
  );

  const conflictResult: any = {
    readiness: {
      products: ["one", "two"].map((id) => ({
        admissions: [structuredClone(admission)],
        id,
      })),
      ready: true,
    },
    site_manifest: {
      products: ["one", "two"].map((id) => ({
        admissions: [structuredClone(admission)],
        id,
      })),
      readiness_record_sha256: "e".repeat(64),
    },
  };
  assert.throws(
    () =>
      bindAdmissionProjections(
        conflictResult,
        [
          {
    admissions: [{ ...admission, projection }],
    id: "one",
          },
          {
            admissions: [
              {
      ...admission,
                projection: {
                  ...projection,
                  projection_sha256: "f".repeat(64),
                },
              },
            ],
    id: "two",
          },
        ] as any,
        tapSource,
      ),
    /conflicting current projections/i,
  );
});

test("derives site and gallery identities from protected current outputs", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-site-metadata-"));
  try {
    mkdirSync(join(root, "api"));
    mkdirSync(join(root, "guide"));
    writeFileSync(join(root, "index.html"), "browser\n");
    writeFileSync(join(root, "api/index.html"), "api\n");
    writeFileSync(join(root, "guide/index.html"), "docs\n");
    const metadata = derivePagesSiteMetadata(
      root,
      {
      kind: "kandelo-pages-vfs-products",
      products: [{ id: "mini", load: "eager" }],
      schema: 1,
      },
      {
      kind: "kandelo-pages-vfs-product-gallery",
        products: [
          { gallery_entries: ["shell"], id: "mini", vfs_image: "shell" },
        ],
      schema: 1,
      },
      `export const PRESET_LIBRARY = [\n    id: "shell",\n];\n`,
      `const LIVE_DEMO_SPECS = {\n  shell: {\n    image: "shell",\n  },\n};\n`,
    );
    assert.deepEqual(metadata.products, [
      {
        gallery_entries: ["shell"],
        id: "mini",
        vfs_image: "shell",
      },
    ]);
    assert.deepEqual(
      metadata.files.map((file: any) => file.path),
      ["api/index.html", "guide/index.html", "index.html"],
    );
    assert.deepEqual(metadata.browser, metadata.files[2]);
    assert.deepEqual(metadata.documentation, metadata.files[1]);
    assert.deepEqual(metadata.api, metadata.files[0]);

    assert.throws(
      () =>
        derivePagesSiteMetadata(
          root,
          {
        kind: "kandelo-pages-vfs-products",
        products: [{ id: "mini", load: "eager" }],
        schema: 1,
          },
          {
        kind: "kandelo-pages-vfs-product-gallery",
            products: [
              { gallery_entries: ["shell"], id: "mini", vfs_image: "node" },
            ],
        schema: 1,
          },
          `export const PRESET_LIBRARY = [\n    id: "shell",\n];\n`,
          `const LIVE_DEMO_SPECS = {\n  shell: {\n    image: "shell",\n  },\n};\n`,
        ),
      /reviewed VFS image/i,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects early holds when the protected tap repository or Git identity differs", async (t) => {
  for (const mutation of ["repository", "commit", "tree"] as const) {
    await t.test(mutation, async () => {
      const root = mkdtempSync(
        join(tmpdir(), `kandelo-pages-tap-${mutation}-`),
      );
      try {
        const fixture = await createMiniaturePagesProducerFixture(
          root,
          "missing-product",
        );
        const handoff = JSON.parse(readFileSync(fixture.handoffPath, "utf8"));
        if (mutation === "repository") {
          execFileSync(
            "git",
            [
              "remote",
              "set-url",
              "origin",
              "https://github.com/example/homebrew-tap-core.git",
            ],
            { cwd: handoff.tap_root },
          );
        } else {
          handoff.tap_source[mutation] =
            mutation === "commit" ? "a".repeat(40) : "b".repeat(40);
          writeFileSync(fixture.handoffPath, canonicalJsonBytes(handoff));
        }
        await assert.rejects(
          () =>
            producePagesArtifacts(
            fixture.handoffPath,
            fixture.outputRoot,
            fixture.oci,
            fixture.dependencies,
          ),
          /tap.*(repository|Git identity)/i,
        );
        assert.equal(existsSync(fixture.outputRoot), false);
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    });
  }
});

test("rejects an early hold after the observed tap checkout mutates", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-tap-postflight-"));
  try {
    const fixture = await createMiniaturePagesProducerFixture(
      root,
      "missing-product",
    );
    const handoff = JSON.parse(readFileSync(fixture.handoffPath, "utf8"));
    const listImmutableReferences = fixture.oci.listImmutableReferences.bind(
      fixture.oci,
    );
    fixture.oci.listImmutableReferences = async (repository) => {
      writeFileSync(
        join(handoff.tap_root, "post-observation-mutation"),
        "dirty\n",
      );
      return listImmutableReferences(repository);
    };
    await assert.rejects(
      () =>
        producePagesArtifacts(
        fixture.handoffPath,
        fixture.outputRoot,
        fixture.oci,
        fixture.dependencies,
      ),
      /tap.*clean/i,
    );
    assert.equal(existsSync(fixture.outputRoot), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("rejects sealed product mutation before final-site readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-sealed-mutation-"));
  try {
    const fixture = await createMiniaturePagesProducerFixture(
      root,
      "sealed-product-mutation",
    );
    await assert.rejects(
      () =>
        producePagesArtifacts(
        fixture.handoffPath,
        fixture.outputRoot,
        fixture.oci,
        fixture.dependencies,
      ),
      /sealed product .* differs from its authenticated identity/iu,
    );
    assert.equal(existsSync(fixture.outputRoot), false);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("hands one private sealed map to Phase B after product evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-producer-phase-b-"));
  try {
    const fixture = await createMiniaturePagesProducerFixture(root, "ready");
    const handoff = JSON.parse(readFileSync(fixture.handoffPath, "utf8"));
    let buildCalls = 0;
    let evidenceCalls = 0;
    let siteCalls = 0;
    const buildProduct = fixture.dependencies.buildProduct!;
    const runEvidence = fixture.dependencies.runEvidence!;
    fixture.dependencies.buildProduct = async (request) => {
      buildCalls += 1;
      return buildProduct(request);
    };
    fixture.dependencies.runEvidence = async (request) => {
      evidenceCalls += 1;
      return runEvidence(request);
    };
    fixture.dependencies.buildSite = (options) => {
      siteCalls += 1;
      assert.equal(buildCalls, 2);
      assert.equal(evidenceCalls, 4);
      assert.equal(resolve(options.productMapPath), options.productMapPath);
      const map = JSON.parse(readFileSync(options.productMapPath, "utf8"));
      assert.deepEqual(Object.keys(map).sort(), ["kind", "products", "schema"]);
      assert.deepEqual(
        map.products.map(({ id, load }: any) => ({ id, load })),
        [
        { id: "base", load: "eager" },
        { id: "mini", load: "lazy" },
        ],
      );
      assert.ok(
        map.products.every(
          ({ private_path }: any) =>
            resolve(private_path) === private_path &&
            private_path.includes("sealed-products"),
        ),
      );
      cpSync(handoff.site_source_root, options.outputRoot, { recursive: true });
      for (const file of options.additionalFiles ?? []) {
        const path = join(options.outputRoot, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.body);
      }
      for (const product of map.products) {
        const path = join(options.outputRoot, product.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, readFileSync(product.private_path));
      }
      return derivePagesSiteMetadata(
        options.outputRoot,
        {
        kind: "kandelo-pages-vfs-products",
          products: [
            { id: "base", load: "eager" },
            { id: "mini", load: "lazy" },
          ],
        schema: 1,
        },
        {
        kind: "kandelo-pages-vfs-product-gallery",
        products: [
          { gallery_entries: [], id: "base", vfs_image: "base" },
          { gallery_entries: ["shell"], id: "mini", vfs_image: "shell" },
        ],
        schema: 1,
        },
        `export const PRESET_LIBRARY = [\n    id: "shell",\n];\n`,
        `const LIVE_DEMO_SPECS = {\n  shell: {\n    image: "shell",\n  },\n};\n`,
      ) as any;
    };

    await producePagesArtifacts(
      fixture.handoffPath,
      fixture.outputRoot,
      fixture.oci,
      fixture.dependencies,
    );
    assert.equal(siteCalls, 1);
    assert.equal(
      existsSync(join(fixture.outputRoot, "private-product-map.json")),
      false,
    );
    const deployment = JSON.parse(
      readFileSync(
        join(
          fixture.outputRoot,
          "source-tree/.well-known/kandelo/pages-deployment.json",
        ),
      "utf8",
      ),
    );
    assert.equal(deployment.products.length, 2);
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
      const root = mkdtempSync(
        join(tmpdir(), `kandelo-pages-producer-${scenario}-`),
      );
      try {
        const fixture = await createMiniaturePagesProducerFixture(
          root,
          scenario,
        );
        let buildCalls = 0;
        let evidenceCalls = 0;
        const buildProduct = fixture.dependencies.buildProduct!;
        const runEvidence = fixture.dependencies.runEvidence!;
        fixture.dependencies.buildProduct = async (request) => {
          buildCalls += 1;
          return buildProduct(request);
        };
        fixture.dependencies.runEvidence = async (request) => {
          evidenceCalls += 1;
          return runEvidence(request);
        };
        if (scenario === "postflight-failure") {
          await assert.rejects(
            () =>
              producePagesArtifacts(
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
        const readiness = JSON.parse(
          readFileSync(join(fixture.outputRoot, "readiness.json"), "utf8"),
        );
        if (scenario === "ready") {
          assert.equal(
            readiness.ready,
            true,
            JSON.stringify(readiness.blockers),
          );
          assert.equal(
            existsSync(join(fixture.outputRoot, "sealed-products")),
            false,
          );
          assert.ok(existsSync(join(fixture.outputRoot, "site-manifest.json")));
          assert.ok(existsSync(join(fixture.outputRoot, "source-tree")));
          const resolved = JSON.parse(
            readFileSync(
            join(
              fixture.outputRoot,
              "artifacts/products/base/resolved-inputs.json",
            ),
            "utf8",
            ),
          );
          assert.equal(resolved.inputs[0].reference, undefined);
          assert.match(resolved.inputs[1].reference, /\/products\/inputs\//u);
          const childResolved = JSON.parse(
            readFileSync(
            join(
              fixture.outputRoot,
              "artifacts/products/mini/resolved-inputs.json",
            ),
            "utf8",
            ),
          );
          assert.match(
            childResolved.inputs[0].reference,
            /\/products\/base\/sha256-[0-9a-f]{64}\/base-18\.vfs\.zst\?sha256=/u,
          );
          assert.equal(
            childResolved.inputs[0].effective_materialization,
            "embedded",
          );
          assert.equal(buildCalls, 2);
          assert.equal(evidenceCalls, 4);
          assert.deepEqual(
            readiness.products.map(({ id }: { id: string }) => id),
            ["base", "mini"],
          );
        } else {
          assert.equal(readiness.ready, false);
          assert.equal(readiness.site_metadata_sha256, null);
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

const assembledSiteOutput =
  process.env.KANDELO_ABI_STAGING_ASSEMBLED_SITE_OUTPUT;

test(
  "produces one exact seven-product assembled-site fixture for Chromium",
  {
    skip:
      assembledSiteOutput === undefined
        ? "assembled-site production is exercised only by the Chromium atomic gate"
        : false,
  },
  async () => {
    const outputRoot = resolve(assembledSiteOutput!);
    assert.equal(
      existsSync(outputRoot),
      false,
      "assembled-site output must start absent",
    );
    const root = mkdtempSync(
      join(tmpdir(), "kandelo-pages-assembled-producer-"),
    );
    const fixture = await createSevenProductAssembledFixture(root, outputRoot);
    try {
      await producePagesArtifacts(
        fixture.handoffPath,
        fixture.outputRoot,
        fixture.oci,
        fixture.dependencies,
      );
      const sourceTree = join(outputRoot, "source-tree");
      const deployment = JSON.parse(
        readFileSync(
          join(sourceTree, ".well-known/kandelo/pages-deployment.json"),
          "utf8",
        ),
      );
      assert.deepEqual(
        deployment.products.map(({ id, load }: any) => ({ id, load })),
        assembledPagesProducts,
      );
      assert.equal(
        deployment.files.filter(({ path }: any) =>
          /(?:^|\/)products\/.*\.vfs(?:\.zst)?$/u.test(path),
        ).length,
        assembledPagesProducts.length,
      );
      assertAssembledKernelBinding(
        deployment,
        (fixture as any).assembledKernelBinding,
      );
      assertExactProducedPrivateMapAuthority(root, sourceTree, deployment);
    } finally {
      for (const path of (fixture as any).assembledCleanupPaths ?? []) {
        rmSync(path, { force: true, recursive: true });
      }
      rmSync(root, { force: true, recursive: true });
    }
  },
);

test("ships the seven-product tree without candidate records or product evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-direct-shipping-"));
  const outputRoot = join(root, "output");
  const fixtureProgram = join(root, "direct-fixture.wasm");
  writeFileSync(fixtureProgram, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const fixtureKernel = join(root, "direct-kernel.wasm");
  writeFileSync(fixtureKernel, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const fixture = await createSevenProductAssembledFixture(
    root,
    outputRoot,
    fixtureProgram,
    fixtureKernel,
  );
  const collectCurrentInputs = fixture.dependencies.collectCurrentInputs!;
  fixture.dependencies.collectCurrentInputs = (options) => {
    assert.equal(
      existsSync(dirname(options.outRoot)),
      true,
      "direct shipping must prepare the shared current-input parent",
    );
    return collectCurrentInputs(options);
  };
  let evidenceCalls = 0;
  fixture.dependencies.runEvidence = async () => {
    evidenceCalls += 1;
    throw new Error("direct shipping must not run product evidence");
  };
  const handoff = JSON.parse(readFileSync(fixture.handoffPath, "utf8"));
  fixture.dependencies.buildSite = (options) => {
    cpSync(handoff.site_source_root, options.outputRoot, { recursive: true });
    for (const file of options.additionalFiles ?? []) {
      const path = join(options.outputRoot, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.body);
    }
    const productMap = JSON.parse(readFileSync(options.productMapPath, "utf8"));
    for (const product of productMap.products) {
      const path = join(options.outputRoot, product.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(product.private_path));
    }
    const repoRoot = resolve(new URL("..", import.meta.url).pathname);
    return derivePagesSiteMetadata(
      options.outputRoot,
      { kind: "kandelo-pages-vfs-products", products: assembledPagesProducts, schema: 1 },
      JSON.parse(readFileSync(join(
        repoRoot,
        "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json",
      ), "utf8")),
      readFileSync(join(repoRoot, "apps/browser-demos/pages/kandelo/presets.ts"), "utf8"),
      readFileSync(join(
        repoRoot,
        "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts",
      ), "utf8"),
    ) as any;
  };
  try {
    await shipPagesArtifacts(
      fixture.handoffPath,
      fixture.outputRoot,
      fixture.oci,
      fixture.dependencies,
    );
    assert.equal(evidenceCalls, 0);
    const deployment = JSON.parse(
      readFileSync(
        join(outputRoot, "source-tree/.well-known/kandelo/pages-deployment.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      deployment.products.map(({ id, load }: any) => ({ id, load })),
      assembledPagesProducts,
    );
    assert.equal(deployment.shipping_mode, "direct-canonical-bottles");
    assert.deepEqual(readdirSync(outputRoot), ["source-tree"]);
  } finally {
    for (const path of (fixture as any).assembledCleanupPaths ?? []) {
      rmSync(path, { force: true, recursive: true });
    }
    rmSync(root, { force: true, recursive: true });
  }
});

function assertExactProducedPrivateMapAuthority(
  root: string,
  sourceTree: string,
  deployment: any,
) {
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const exactMap = {
    kind: "kandelo-pages-private-product-map",
    products: deployment.products.map((product: any) => ({
      bytes: product.vfs_bytes,
      id: product.id,
      load: product.load,
      path: product.path,
      private_path: join(sourceTree, product.path),
      sha256: product.vfs_sha256,
    })),
    schema: 1,
  };
  const writeMap = (name: string, value: any) => {
    const path = join(root, `${name}.private-product-map.json`);
    writeFileSync(path, canonicalJsonBytes(value));
    return path;
  };
  const load = (name: string, value: any) =>
    loadCanonicalPagesProductMap({
      mapPath: writeMap(name, value),
      sourceRoot: repoRoot,
    });
  assert.equal(
    load("exact-produced", exactMap).products.length,
    assembledPagesProducts.length,
  );

  const mutations: Array<[string, (value: any) => void]> = [
    [
      "extra",
      (value) =>
        value.products.push({ ...value.products[0], id: "browser-rogue" }),
    ],
    ["wrong-load", (value) => (value.products[0].load = "eager")],
    [
      "duplicate-rootfs",
      (value) => (value.products[0] = { ...value.products.at(-1) }),
    ],
    ["legacy-path", (value) => (value.products[0].path = "rootfs.vfs")],
    [
      "candidate-path",
      (value) =>
        (value.products[0].path = value.products[0].path.replace(
          "products/",
          "products/-candidates/",
        )),
    ],
    [
      "prior-abi",
      (value) =>
        (value.products[0].path = value.products[0].path.replace(
          `-${ABI_VERSION}.vfs.zst`,
          `-${ABI_VERSION - 1}.vfs.zst`,
        )),
    ],
  ];
  for (const [name, mutate] of mutations) {
    const value = structuredClone(exactMap);
    mutate(value);
    assert.throws(() => load(name, value), name);
  }
}

const assembledPagesProducts = [
  { id: "browser-lamp", load: "lazy" },
  { id: "browser-main-shell", load: "eager" },
  { id: "browser-nginx", load: "lazy" },
  { id: "browser-nginx-php", load: "lazy" },
  { id: "browser-node", load: "lazy" },
  { id: "browser-wordpress", load: "lazy" },
  { id: "platform-rootfs", load: "eager" },
] as const;

async function createSevenProductAssembledFixture(
  root: string,
  outputRoot: string,
  fixtureProgramOverride?: string,
  fixtureKernelOverride?: string,
): Promise<Awaited<ReturnType<typeof createMiniaturePagesProducerFixture>>> {
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const fixtureProgram = fixtureProgramOverride ?? createAssembledFixtureProgram(root);
  const fixture = await createMiniaturePagesProducerFixture(root, "ready");
  const handoff = JSON.parse(readFileSync(fixture.handoffPath, "utf8"));
  handoff.products = assembledPagesProducts.map(({ id }) => ({
    current_inputs: handoff.products[0].current_inputs,
    id,
  }));
  handoff.source_root = repoRoot;
  handoff.target_abi = assembledTargetAbi;
  const runtimeBundle = JSON.parse(
    readFileSync(handoff.runtime_bundle, "utf8"),
  );
  runtimeBundle.target_abi = assembledTargetAbi;
  writeFileSync(handoff.runtime_bundle, canonicalJsonBytes(runtimeBundle));
  writeFileSync(fixture.handoffPath, canonicalJsonBytes(handoff));

  const runtimeBytes = new Uint8Array(readFileSync(handoff.runtime_bundle));
  const definitions = ["node", "browser"].map((host) => {
    const value = {
      host,
      id: `assembled-${host}`,
      implementation: [],
      probe: {},
      runner: "exec",
      timeout_seconds: 30,
    };
    return { ...value, definition_sha256: sha256(canonicalJsonBytes(value)) };
  });
  const manifests = assembledPagesProducts.map(({ id }) => {
    const manifest = {
      architecture: "wasm32",
      boot: { argv: ["/bin/sh"], cwd: "/", env: {}, gid: 0, uid: 0 },
      builder: "assembled-fixture-only",
      composition: {},
      id,
      mounts: [{ path: "/", readonly: false, source: "built-image" }],
      output: `${id}.vfs.zst`,
      schema: 1,
    };
    return {
      manifest,
      path: `images/vfs/products/${id}.toml`,
      sha256: sha256(canonicalJsonBytes(manifest)),
    };
  });
  const catalog = {
    kind: "kandelo-vfs-product-catalog",
    products: manifests,
    schema: 1,
  };
  const pages = {
    kind: "kandelo-pages-vfs-products",
    products: assembledPagesProducts,
    schema: 1,
  };
  const tests = {
    kind: "kandelo-test-vfs-products",
    registrations: assembledPagesProducts.map(({ id }) => ({
      applicability: { class: "required" },
      browser: ["assembled-browser"],
      node: ["assembled-node"],
      product: id,
    })),
    schema: 1,
  };
  const gallery = JSON.parse(
    readFileSync(
      join(
        repoRoot,
        "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json",
      ),
      "utf8",
    ),
  );
  const protectedDocument = (path: string, value: any) => {
    const bytes = canonicalJsonBytes(value);
    return { bytes, path, source_bytes: bytes, value };
  };
  fixture.dependencies.loadProtectedAuthorities = () => ({
    catalog: protectedDocument(
      "images/vfs/products/generated/catalog.json",
      catalog,
    ),
    definitions: protectedDocument(
      "abi/staging/evidence-definitions.generated.json",
      {
        definitions,
        kind: "kandelo-vfs-evidence-definitions",
        schema: 1,
        version: 1,
      },
    ),
    gallery,
    liveSetupSource: readFileSync(
      join(
        repoRoot,
        "apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts",
      ),
      "utf8",
    ),
    pages: protectedDocument(
      "apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.generated.json",
      pages,
    ),
    presentationSource: readFileSync(
      join(repoRoot, "apps/browser-demos/pages/kandelo/presets.ts"),
      "utf8",
    ),
    tests: protectedDocument("tests/vfs-products.generated.json", tests),
  });
  fixture.dependencies.observeRuntime = () => ({
    devShellLockSha256: "5".repeat(64),
    source,
    targetAbi: assembledTargetAbi,
  });

  const candidates = new Map<string, ReturnType<typeof assembledCandidate>>(
    manifests.map(({ manifest, sha256: manifestSha256 }) => {
      const currentBody = new TextEncoder().encode(
        `assembled current input ${manifest.id}\n`,
      );
      const candidate = assembledCandidate(
        manifest.id,
        manifest.output,
        manifestSha256,
        currentBody,
        runtimeBytes,
      );
      return [manifest.id, candidate] as const;
    }),
  );
  fixture.oci = {
    async fetchBlob(_repository, digest, bytes) {
      const body = [...candidates.values()]
        .map((candidate) => candidate.blobs.get(digest))
        .find((candidate) => candidate !== undefined);
      assert.ok(body, `unexpected assembled fixture blob ${digest}`);
      assert.equal(body.byteLength, bytes);
      return body;
    },
    async fetchCanonicalOci() {
      throw new Error("assembled fixture has no admitted canonical layer");
    },
    async fetchManifest(reference) {
      const candidate = [...candidates.values()].find(
        (value) => value.reference === reference,
      );
      assert.ok(
        candidate,
        `unexpected assembled fixture manifest ${reference}`,
      );
      return candidate.manifest;
    },
    async listImmutableReferences(repository) {
      if (repository.includes("/admissions")) return [];
      const candidate = candidates.get(repository.split("/").at(-1)!);
      return candidate === undefined ? [] : [candidate.reference];
    },
    async readAdmissionRecord() {
      throw new Error("assembled fixture admission is unavailable");
    },
  };
  fixture.dependencies.collectCurrentInputs = (options) => {
    const candidate = candidates.get(options.productId)!;
    const path = `inputs/objects/package-${options.productId}`;
    mkdirSync(join(options.outRoot, "inputs/objects"), { recursive: true });
    writeFileSync(join(options.outRoot, path), candidate.currentBody);
    return {
      build_environment: candidate.resolved.build_environment,
      kind: "kandelo-vfs-product-input-object-inventory",
      objects: [
        {
          ...candidate.resolved.inputs[0],
          adapter: "assembled-current-input-v1",
          path,
          reference: undefined,
        },
      ],
      product: {
        architecture: "wasm32",
        id: options.productId,
        manifest_path: `images/vfs/products/${options.productId}.toml`,
        manifest_sha256: manifests.find(
          ({ manifest }) => manifest.id === options.productId,
        )!.sha256,
      },
      schema: 1,
      source,
      target_abi: assembledTargetAbi,
    };
  };
  fixture.dependencies.buildProduct = async (request) => {
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    for (const directory of [
      "/bin",
      "/etc",
      "/etc/dinit.d",
      "/etc/kandelo",
      "/home",
      "/home/user",
      "/sbin",
      "/tmp",
      "/usr",
      "/usr/bin",
      "/var",
      "/var/www",
      "/var/www/html",
      "/var/www/html/wp-content",
    ]) {
      fs.mkdir(directory, 0o755);
    }
    const program = new Uint8Array(readFileSync(fixtureProgram));
    for (const path of [
      "/bin/sh",
      "/bin/bash",
      "/sbin/dinit",
      "/usr/bin/ready",
    ]) {
      const fd = fs.open(path, 0x40 | 0x1 | 0x200, 0o755);
      fs.write(fd, program, 0, program.byteLength);
      fs.close(fd);
    }
    const shellConfig = new TextEncoder().encode(
      '{"argv":["bash","-l","-i"],"path":"/bin/bash","version":1}\n',
    );
    const shellConfigFd = fs.open(
      "/etc/kandelo/shell.json",
      0x40 | 0x1 | 0x200,
      0o644,
    );
    fs.write(shellConfigFd, shellConfig, 0, shellConfig.byteLength);
    fs.close(shellConfigFd);
    const nginxService = new TextEncoder().encode(
      "type = process\ncommand = /bin/sh\n",
    );
    const serviceFd = fs.open("/etc/dinit.d/nginx", 0x40 | 0x1 | 0x200, 0o644);
    fs.write(serviceFd, nginxService, 0, nginxService.byteLength);
    fs.close(serviceFd);
    const vfs = await fs.saveImage({
      metadata: {
        abiSnapshotSha256: assembledTargetAbi.snapshot_sha256,
        kernelAbi: assembledTargetAbi.version,
        version: 1,
      },
      normalizeTimestampsMs: 0,
    });
    const report = assembledBuilderReport(request.resolved_inputs, vfs);
    return { builder_report: report, vfs };
  };
  fixture.dependencies.runEvidence = async (request) =>
    assembledEvidenceReceipt(request, runtimeBytes);
  const programAuthority = createAssembledBrowserProgramAuthority(
    root,
    repoRoot,
    fixtureProgram,
    fixtureKernelOverride,
  );
  (fixture as any).assembledCleanupPaths = programAuthority.cleanupPaths;
  (fixture as any).assembledKernelBinding = programAuthority.kernelBinding;
  const programIndexChecker = join(root, "assembled-program-index-checker");
  writeFileSync(
    programIndexChecker,
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -eq 4 ] && [ "$1" = build-deps ] &&
   [ "$2" = program-index-context-check ] && [ "$3" = --source-repo-root ] &&
   [ "$4" = ${JSON.stringify(programAuthority.root)} ]; then
  exit 0
fi
echo "assembled fixture received an unexpected xtask invocation" >&2
exit 97
`,
  );
  chmodSync(programIndexChecker, 0o755);
  fixture.dependencies.buildSite = (options) =>
    buildFinalPagesSite({
      ...options,
      // Every production Phase B build still runs, including Vite, VitePress,
      // and TypeDoc. Only the bounded source-index checker is substituted; the
      // fixture's guest process was compiled privately through the normal SDK.
      execute(request) {
        const args =
          request.name === "browser"
            ? [
                request.arguments[0]!,
                `WASM_POSIX_XTASK_BIN=${programIndexChecker}`,
                `WASM_POSIX_BINARY_RESOLVER_REPO_ROOT=${programAuthority.root}`,
                ...request.arguments.slice(1),
              ]
            : request.arguments;
        execFileSync(request.command, args, {
          cwd: request.workingDirectory,
          env: request.environment,
          stdio: "inherit",
        });
      },
    });
  fixture.outputRoot = outputRoot;
  return fixture;
}

function assembledCandidate(
  productId: string,
  output: string,
  manifestSha256: string,
  currentBody: Uint8Array,
  runtimeBytes: Uint8Array,
) {
  const repository =
    `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${assembledTargetAbi.version}-candidates/` +
    `products/${productId}`;
  const resolved = {
    build_environment: {
      dev_shell_lock_sha256: "5".repeat(64),
      policy_sha256: "4".repeat(64),
    },
    inputs: [
      {
        architecture: "wasm32",
        bytes: currentBody.byteLength,
        declared_materialization: "embedded",
        effective_materialization: "embedded",
        id: `package-${productId}`,
        kind: "package-output",
        path: `inputs/objects/package-${productId}`,
        reference: `${repository}@sha256:${sha256(currentBody)}`,
        role: "runtime",
        sha256: sha256(currentBody),
      },
    ],
    kind: "kandelo-resolved-vfs-product-inputs",
    product: {
      architecture: "wasm32",
      id: productId,
      manifest_path: `images/vfs/products/${productId}.toml`,
      manifest_sha256: manifestSha256,
      output,
    },
    reference_class: "candidate",
    schema: 1,
    source,
    target_abi: assembledTargetAbi,
  };
  const report = assembledBuilderReport(resolved, undefined);
  const resolvedBytes = canonicalJsonBytes(resolved);
  const reportBytes = canonicalJsonBytes(report);
  const artifact = (body: Uint8Array) => ({
    bytes: body.byteLength,
    immutable_reference: `${repository}@sha256:${sha256(body)}`,
    sha256: sha256(body),
  });
  const candidateVfsSha256 = "8".repeat(64);
  const record = {
    artifacts: {
      builder_report: artifact(reportBytes),
      lazy_inputs: [],
      resolved_inputs: artifact(resolvedBytes),
      runtime_bundle: artifact(runtimeBytes),
      vfs_image: {
        bytes: 99,
        immutable_reference: `${repository}@sha256:${candidateVfsSha256}`,
        sha256: candidateVfsSha256,
      },
    },
    kind: "kandelo-vfs-candidate-product",
    nonendorsed: true,
    product: resolved.product,
    reference_class: "candidate",
    schema: 1,
    source,
    target_abi: assembledTargetAbi,
  };
  const config = canonicalJsonBytes(record);
  const descriptor = (
    role: string,
    title: string,
    mediaType: string,
    body: Uint8Array,
  ) => ({
    annotations: {
      "dev.kandelo.abi-staging.role": role,
      "org.opencontainers.image.title": title,
    },
    digest: `sha256:${sha256(body)}`,
    mediaType,
    size: body.byteLength,
  });
  const descriptors = [
    descriptor(
      "candidate-product-record",
      "candidate-product-record.json",
      "application/vnd.kandelo.abi-staging.product.candidate.v1+json",
      config,
    ),
    {
      annotations: {
        "dev.kandelo.abi-staging.role": "vfs-image",
        "org.opencontainers.image.title": output,
      },
      digest: `sha256:${candidateVfsSha256}`,
      mediaType: "application/vnd.kandelo.vfs.image.v1",
      size: 99,
    },
    descriptor(
      "builder-report",
      "builder-report.json",
      "application/vnd.kandelo.vfs.builder-report.v1+json",
      reportBytes,
    ),
    descriptor(
      "resolved-inputs",
      "resolved-inputs.json",
      "application/vnd.kandelo.vfs.resolved-inputs.v1+json",
      resolvedBytes,
    ),
    descriptor(
      "runtime-bundle",
      "runtime-bundle.json",
      "application/vnd.kandelo.abi-staging.runtime-bundle.v1+json",
      runtimeBytes,
    ),
  ];
  const manifest = canonicalJsonBytes({
    annotations: {
      "dev.kandelo.abi-staging.architecture": "wasm32",
      "dev.kandelo.abi-staging.classification": "public-candidate-not-endorsed",
      "dev.kandelo.abi-staging.kind": "candidate-product",
      "dev.kandelo.abi-staging.nonendorsed": "true",
      "dev.kandelo.abi-staging.product": productId,
      "dev.kandelo.abi-staging.target-abi": String(assembledTargetAbi.version),
      "org.opencontainers.image.source":
        "https://github.com/Automattic/kandelo",
    },
    artifactType:
      "application/vnd.kandelo.abi-staging.product.candidate.v1+json",
    config: descriptors[0],
    layers: descriptors.slice(1),
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  });
  return {
    blobs: new Map<string, Uint8Array>([
      [`sha256:${sha256(config)}`, config],
      [`sha256:${sha256(reportBytes)}`, reportBytes],
      [`sha256:${sha256(resolvedBytes)}`, resolvedBytes],
      [`sha256:${sha256(runtimeBytes)}`, runtimeBytes],
    ]),
    currentBody,
    manifest,
    reference: `${repository}@sha256:${sha256(manifest)}`,
    resolved,
  };
}

function assembledBuilderReport(resolved: any, vfs: Uint8Array | undefined) {
  return {
    capture: { complete: true, unreported_reads: [] },
    inputs: resolved.inputs.map((input: any) => ({
      bytes: input.bytes,
      id: input.id,
      kind: input.kind,
      placement: input.effective_materialization,
      role: input.role,
      sha256: input.sha256,
    })),
    kind: "kandelo-vfs-builder-report",
    output: {
      abi: assembledTargetAbi,
      bytes: vfs?.byteLength ?? 99,
      name: resolved.product.output,
      path: resolved.product.output,
      sha256: vfs === undefined ? "8".repeat(64) : sha256(vfs),
    },
    product: resolved.product,
    resolved_inputs_sha256: sha256(canonicalJsonBytes(resolved)),
    schema: 1,
  };
}

function assembledEvidenceReceipt(request: any, runtimeBytes: Uint8Array) {
  const vfsSha256 = sha256(request.vfs);
  const reportSha256 = sha256(canonicalJsonBytes(request.builder_report));
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
    guard_codes: [],
    host: request.host,
    kind: "kandelo-vfs-product-evidence-result",
    outcome: "success",
    product: {
      id: request.product.id,
      manifest_sha256: request.product.manifest_sha256,
    },
    request_digest: sha256(
      canonicalJsonBytes({
        builder_report_sha256: reportSha256,
        definition_sha256: request.definition_sha256,
        host: request.host,
        product_id: request.product.id,
        runtime_bundle_sha256: request.runtime_bundle_sha256,
        vfs_sha256: vfsSha256,
      }),
    ),
    run: {
      attempt: 1,
      job_id: `assembled-${request.host}`,
      repository: source.repository,
      run_id: 7,
      workflow_ref:
        "Automattic/kandelo/.github/workflows/abi-staging-pages-canary.yml@refs/heads/main",
    },
    runtime: {
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
        kernel_asset_sha256: "6".repeat(64),
        service_worker_sha256: "a".repeat(64),
      },
      build_policy_sha256: "4".repeat(64),
      bundle_sha256: sha256(runtimeBytes),
      host_runtime: {
        bundle_sha256: "b".repeat(64),
        bytes: 1,
        generated_abi_sha256: "c".repeat(64),
        worker_protocol_sha256: "d".repeat(64),
      },
      kernel: {
        abi_version: assembledTargetAbi.version,
        bytes: 1,
        snapshot_sha256: assembledTargetAbi.snapshot_sha256,
        wasm_sha256: "6".repeat(64),
      },
      source,
      target_abi: assembledTargetAbi,
    },
    schema: 1,
  };
}

function createAssembledFixtureProgram(root: string): string {
  const source = join(root, "fixture-program.c");
  const program = join(root, "fixture-program.wasm");
  writeFileSync(
    source,
    "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n",
  );
  execFileSync("wasm32posix-cc", ["-Os", source, "-o", program], {
    stdio: "inherit",
  });
  return program;
}

function createAssembledBrowserProgramAuthority(
  root: string,
  repoRoot: string,
  fixtureProgram: string,
  fixtureKernelOverride?: string,
) {
  const authorityRoot = join(root, "browser-program-authority");
  const mirrorRoot = join(authorityRoot, "local-binaries");
  const generationParent = join(
    repoRoot,
    "local-binaries/.kandelo-local-generations/wasm32/task5-assembled-site",
  );
  mkdirSync(mirrorRoot, { recursive: true });
  mkdirSync(generationParent, { recursive: true });
  const generation = mkdtempSync(join(generationParent, "fixture-"));
  try {
    writeFileSync(join(authorityRoot, "Cargo.toml"), "[workspace]\n");
    writeFileSync(
      join(authorityRoot, "package.json"),
      '{"name":"kandelo","private":true}\n',
    );
    const kernelSource = fixtureKernelOverride ?? ["local-binaries", "binaries"]
      .map((directory) => join(repoRoot, directory, "kernel.wasm"))
      .find((path) => existsSync(path));
    assert.ok(kernelSource, "assembled browser authority requires the prepared kernel");
    const kernel = readFileSync(kernelSource);
    const privateKernel = join(generation, "kernel.wasm");
    writeFileSync(privateKernel, kernel);
    symlinkSync(privateKernel, join(mirrorRoot, "kernel.wasm"));
    assert.deepEqual(
      readdirSync(mirrorRoot),
      ["kernel.wasm"],
      "canonical Pages fixture must not materialize legacy browser programs",
    );
    return {
      cleanupPaths: [generation],
      kernelBinding: {
        bytes: kernel.byteLength,
        sha256: sha256(kernel),
        source: kernelSource,
      },
      root: authorityRoot,
    };
  } catch (error) {
    rmSync(generation, { force: true, recursive: true });
    throw error;
  }
}

function assertAssembledKernelBinding(
  deployment: any,
  binding: { bytes: number; sha256: string; source: string },
) {
  const source = readFileSync(binding.source);
  assert.equal(
    source.byteLength,
    binding.bytes,
    "prepared kernel length changed during Phase B",
  );
  assert.equal(
    sha256(source),
    binding.sha256,
    "prepared kernel digest changed during Phase B",
  );
  const built = deployment.files.filter(({ path }: any) =>
    /^assets\/(?:kandelo-)?kernel-[^/]+\.wasm$/u.test(path),
  );
  assert.deepEqual(
    built.map(({ bytes, sha256 }: any) => ({ bytes, sha256 })),
    [{ bytes: binding.bytes, sha256: binding.sha256 }],
  );
}

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
      Object.entries(fixture.resolved.product).filter(
        ([key]) => key !== "output",
      ),
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
  const repository =
    "ghcr.io/kandelo-dev/homebrew-tap-core-abi-18-candidates/products/mini";
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
        : [
            {
          architecture: "wasm32",
          bytes: repositoryBundle.byteLength,
          declared_materialization: "embedded",
          effective_materialization: "embedded",
          id: "repository-rootfs-source",
          kind: "repository-path",
          path: "inputs/objects/repository-rootfs-source",
              reference: `${repository}@sha256:${sha256(repositoryBundle)}`,
          repository_id: "rootfs-source",
          paths: repositoryPaths,
          role: "runtime",
          sha256: sha256(repositoryBundle),
            },
          ]),
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
  const vfsSha256 =
    repositoryBundle === undefined ? "8".repeat(64) : sha256(repositoryBundle);
  const report = {
    capture: { complete: true, unreported_reads: [] },
    inputs: resolved.inputs.map(
      ({ bytes, id, kind, role, effective_materialization }) => ({
      bytes,
      id,
      kind,
      placement: effective_materialization,
      role,
      sha256: resolved.inputs.find((input) => input.id === id)!.sha256,
      }),
    ),
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
    lazy_inputs: [
      {
      bytes: lazy.byteLength,
      id: "package-tool-output-tool",
      immutable_reference: `${repository}@sha256:${sha256(lazy)}`,
      kind: "package-output",
      sha256: sha256(lazy),
      },
    ],
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
    descriptor(
      "candidate-product-record",
      "candidate-product-record.json",
      "application/vnd.kandelo.abi-staging.product.candidate.v1+json",
      config,
    ),
    {
      annotations: {
        "dev.kandelo.abi-staging.role": "vfs-image",
        "org.opencontainers.image.title": "mini.vfs.zst",
      },
      digest: `sha256:${vfsSha256}`,
      mediaType: "application/vnd.kandelo.vfs.image.v1",
      size: 99,
    },
    descriptor(
      "builder-report",
      "builder-report.json",
      "application/vnd.kandelo.vfs.builder-report.v1+json",
      reportBytes,
    ),
    descriptor(
      "resolved-inputs",
      "resolved-inputs.json",
      "application/vnd.kandelo.vfs.resolved-inputs.v1+json",
      resolvedBytes,
    ),
    descriptor(
      "runtime-bundle",
      "runtime-bundle.json",
      "application/vnd.kandelo.abi-staging.runtime-bundle.v1+json",
      runtime,
    ),
    descriptor(
      "lazy-input-0000",
      "lazy-input-package-tool-output-tool",
      "application/vnd.kandelo.vfs.lazy-input.v1",
      lazy,
    ),
  ];
  const manifest = canonicalJsonBytes({
    annotations: {
      "dev.kandelo.abi-staging.architecture": "wasm32",
      "dev.kandelo.abi-staging.classification": "public-candidate-not-endorsed",
      "dev.kandelo.abi-staging.kind": "candidate-product",
      "dev.kandelo.abi-staging.nonendorsed": "true",
      "dev.kandelo.abi-staging.product": "mini",
      "dev.kandelo.abi-staging.target-abi": "18",
      "org.opencontainers.image.source":
        "https://github.com/Automattic/kandelo",
    },
    artifactType:
      "application/vnd.kandelo.abi-staging.product.candidate.v1+json",
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

function descriptor(
  role: string,
  title: string,
  mediaType: string,
  body: Uint8Array,
) {
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
