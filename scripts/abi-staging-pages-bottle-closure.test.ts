import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  resolveCanonicalPagesBottle,
  type CanonicalPagesBottleTransport,
} from "./abi-staging-pages-bottle-closure.ts";
import * as bottleClosure from "./abi-staging-pages-bottle-closure.ts";

const roots: string[] = [];
const ABI = 43;
const BOTTLE = new TextEncoder().encode("fixture bottle\n");
const BOTTLE_SHA = sha256(BOTTLE);
const DESCRIPTOR_SHA = "d".repeat(64);

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("resolves one current Formula bottle directly from canonical OCI", async () => {
  const fixture = canonicalFixture("nginx");
  const resolved = await resolveCanonicalPagesBottle({
    abi: ABI,
    formula: "nginx",
    tapRoot: fixture.root,
    transport: fixture.transport,
  });

  assert.equal(resolved.formula, "nginx");
  assert.equal(resolved.bottle_sha256, BOTTLE_SHA);
  assert.equal(resolved.bottle_bytes, BOTTLE.byteLength);
  assert.equal(resolved.canonical_reference, fixture.reference);
  assert.equal(resolved.descriptor_sha256, DESCRIPTOR_SHA);
  assert.deepEqual(fixture.repositories, [
    "ghcr.io/kandelo-dev/homebrew-tap-core-abi-43/nginx",
  ]);
});

test("reports a missing bottle stanza before touching OCI", async () => {
  const fixture = canonicalFixture("nginx");
  writeFileSync(join(fixture.root, "Formula/nginx.rb"), "class Nginx < Formula\nend\n");
  await assert.rejects(
    resolveCanonicalPagesBottle({
      abi: ABI,
      formula: "nginx",
      tapRoot: fixture.root,
      transport: fixture.transport,
    }),
    /bottle stanza/u,
  );
  assert.deepEqual(fixture.repositories, []);
});

test("rejects conflicting canonical manifests and bottle identity drift", async () => {
  const conflict = canonicalFixture("nginx", { duplicate: true });
  await assert.rejects(
    resolveCanonicalPagesBottle({
      abi: ABI,
      formula: "nginx",
      tapRoot: conflict.root,
      transport: conflict.transport,
    }),
    /multiple canonical manifests/u,
  );

  const drift = canonicalFixture("nginx", { sidecarSha256: "e".repeat(64) });
  await assert.rejects(
    resolveCanonicalPagesBottle({
      abi: ABI,
      formula: "nginx",
      tapRoot: drift.root,
      transport: drift.transport,
    }),
    /Formula bottle digest/u,
  );
});

test("rejects a canonical manifest whose Formula identity differs", async () => {
  const fixture = canonicalFixture("nginx", { manifestFormula: "python" });
  await assert.rejects(
    resolveCanonicalPagesBottle({
      abi: ABI,
      formula: "nginx",
      tapRoot: fixture.root,
      transport: fixture.transport,
    }),
    /canonical manifest Formula identity/u,
  );
});

test("rejects canonical config for a different architecture", async () => {
  const fixture = canonicalFixture("nginx", { manifestArchitecture: "wasm64" });
  await assert.rejects(
    resolveCanonicalPagesBottle({
      abi: ABI,
      formula: "nginx",
      tapRoot: fixture.root,
      transport: fixture.transport,
    }),
    /canonical config Formula identity/u,
  );
});

test("rejects a canonical manifest without its bottle metadata layer", async () => {
  const fixture = canonicalFixture("nginx", { omitMetadataLayer: true });
  await assert.rejects(
    resolveCanonicalPagesBottle({
      abi: ABI,
      formula: "nginx",
      tapRoot: fixture.root,
      transport: fixture.transport,
    }),
    /layer roles are incomplete/u,
  );
});

test("rejects canonical layers outside their readback order", async () => {
  const fixture = canonicalFixture("nginx", { reorderLayers: true });
  await assert.rejects(
    resolveCanonicalPagesBottle({
      abi: ABI,
      formula: "nginx",
      tapRoot: fixture.root,
      transport: fixture.transport,
    }),
    /layer order differs/u,
  );
});

test("reports every missing Formula in one closure preflight", async () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-bottle-preflight-"));
  roots.push(root);
  mkdirSync(join(root, "Formula"));
  mkdirSync(join(root, "Kandelo/formula"), { recursive: true });
  await assert.rejects(
    (bottleClosure as any).resolveCanonicalPagesBottleClosure({
      abi: ABI,
      formulas: ["nginx", "python"],
      tapRoot: root,
      transport: {
        async fetchBlob() { throw new Error("unexpected blob read"); },
        async fetchManifest() { throw new Error("unexpected manifest read"); },
        async listTags() { throw new Error("unexpected tag read"); },
      },
    }),
    (error: unknown) => {
      assert.match(String(error), /nginx/u);
      assert.match(String(error), /python/u);
      return true;
    },
  );
});

function canonicalFixture(
  formula: string,
  options: {
    duplicate?: boolean;
    manifestArchitecture?: string;
    manifestFormula?: string;
    omitMetadataLayer?: boolean;
    reorderLayers?: boolean;
    sidecarSha256?: string;
  } = {},
): {
  reference: string;
  repositories: string[];
  root: string;
  transport: CanonicalPagesBottleTransport;
} {
  const root = mkdtempSync(join(tmpdir(), "kandelo-pages-bottle-closure-"));
  roots.push(root);
  mkdirSync(join(root, "Formula"));
  mkdirSync(join(root, "Kandelo/formula"), { recursive: true });
  const repository = `ghcr.io/kandelo-dev/homebrew-tap-core-abi-${ABI}/${formula}`;
  writeFileSync(join(root, `Formula/${formula}.rb`), [
    `class ${formula[0]!.toUpperCase()}${formula.slice(1)} < Formula`,
    "  bottle do",
    `    root_url \"https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-${ABI}/${formula}\"`,
    `    sha256 cellar: \"/opt/kandelo/homebrew/Cellar\", wasm32_kandelo: \"${BOTTLE_SHA}\"`,
    "  end",
    "end",
    "",
  ].join("\n"));
  writeFileSync(join(root, `Kandelo/formula/${formula}.json`), JSON.stringify({
    bottle_rebuild: 0,
    bottles: [{
      arch: "wasm32",
      bottle_tag: "wasm32_kandelo",
      bytes: BOTTLE.byteLength,
      cache_key_sha: options.sidecarSha256 ?? BOTTLE_SHA,
      cellar: "/opt/kandelo/homebrew/Cellar",
      kandelo_abi: ABI,
      prefix: "/opt/kandelo/homebrew",
      sha256: options.sidecarSha256 ?? BOTTLE_SHA,
      status: "success",
      url: `https://ghcr.io/v2/kandelo-dev/homebrew-tap-core-abi-${ABI}/${formula}/blobs/sha256:${options.sidecarSha256 ?? BOTTLE_SHA}`,
    }],
    formula_path: `Formula/${formula}.rb`,
    full_name: `kandelo-dev/tap-core/${formula}`,
    kandelo_abi: ABI,
    name: formula,
    schema: 1,
  }));
  const config = configBytes(
    options.manifestFormula ?? formula,
    options.manifestArchitecture ?? "wasm32",
  );
  const manifest = manifestBytes(
    BOTTLE_SHA,
    BOTTLE.byteLength,
    DESCRIPTOR_SHA,
    options.manifestFormula ?? formula,
    config,
    options.omitMetadataLayer ?? false,
    options.reorderLayers ?? false,
  );
  const digest = sha256(manifest);
  const secondConfig = configBytes(formula, "wasm32", "c".repeat(64));
  const second = manifestBytes(
    BOTTLE_SHA,
    BOTTLE.byteLength,
    "c".repeat(64),
    formula,
    secondConfig,
  );
  const secondDigest = sha256(second);
  const tags = [
    `canonical-sha256-${digest}`,
    ...(options.duplicate ? [`canonical-sha256-${secondDigest}`] : []),
  ];
  const byReference = new Map([
    [`${repository}@sha256:${digest}`, manifest],
    [`${repository}@sha256:${secondDigest}`, second],
  ]);
  const repositories: string[] = [];
  return {
    reference: `${repository}@sha256:${digest}`,
    repositories,
    root,
    transport: {
      async fetchBlob(value, digestValue, bytes) {
        assert.equal(value, repository);
        const body = digestValue === `sha256:${sha256(config)}` ? config : secondConfig;
        assert.equal(body.byteLength, bytes);
        assert.equal(`sha256:${sha256(body)}`, digestValue);
        return body;
      },
      async fetchManifest(reference) {
        const value = byReference.get(reference);
        if (value === undefined) throw new Error(`unexpected manifest ${reference}`);
        return value;
      },
      async listTags(value) {
        repositories.push(value);
        return tags;
      },
    },
  };
}

function manifestBytes(
  bottleSha: string,
  bottleBytes: number,
  descriptorSha: string,
  formula = "nginx",
  config = configBytes(formula, "wasm32", descriptorSha),
  omitMetadataLayer = false,
  reorderLayers = false,
): Uint8Array {
  const layers = [
    {
      annotations: { "dev.kandelo.abi-staging.role": "bottle-layer" },
      digest: `sha256:${bottleSha}`,
      mediaType: "application/vnd.kandelo.homebrew.bottle.layer.v1+tar+gzip",
      size: bottleBytes,
    },
    ...(!omitMetadataLayer ? [{
      annotations: { "dev.kandelo.abi-staging.role": "bottle-metadata" },
      digest: `sha256:${"b".repeat(64)}`,
      mediaType: "application/vnd.kandelo.homebrew.bottle.metadata.v1+json",
      size: 10,
    }] : []),
    {
      annotations: { "dev.kandelo.abi-staging.role": "vfs-composition-descriptor" },
      digest: `sha256:${descriptorSha}`,
      mediaType: "application/vnd.kandelo.homebrew.vfs-composition-descriptor.v1+json",
      size: 123,
    },
  ];
  if (reorderLayers) [layers[0], layers[1]] = [layers[1]!, layers[0]!];
  return new TextEncoder().encode(`${JSON.stringify({
    annotations: {
      "dev.kandelo.abi-staging.formula": formula,
      "dev.kandelo.abi-staging.target-abi": String(ABI),
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
    layers,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    schemaVersion: 2,
  })}\n`);
}

function configBytes(
  formula: string,
  architecture: string,
  descriptorSha = DESCRIPTOR_SHA,
): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({
    bottle_layer: { bytes: BOTTLE.byteLength, sha256: BOTTLE_SHA },
    bottle_metadata: { bytes: 10, sha256: "b".repeat(64) },
    candidate_record_sha256: "c".repeat(64),
    classification: "canonical-direct",
    formula: {
      architecture,
      name: formula,
      tap: "kandelo-dev/homebrew-tap-core",
      target_abi: ABI,
    },
    kind: "kandelo-homebrew-canonical-bottle",
    request_sha256: "e".repeat(64),
    schema: 1,
    source: {
      commit: "f".repeat(40),
      repository: "Automattic/kandelo",
      tree: "a".repeat(40),
    },
    vfs_composition_descriptor: { bytes: 123, sha256: descriptorSha },
  })}\n`);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
