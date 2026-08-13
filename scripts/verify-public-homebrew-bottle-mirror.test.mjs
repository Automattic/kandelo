import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { verifyPublicHomebrewBottleMirror } from "./verify-public-homebrew-bottle-mirror.mjs";

const roots = [];
const checkedInPlanUrl = new URL(
  "../homebrew/main-shell-flat-lazy-mirror-plan.json",
  import.meta.url,
);

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kandelo-public-mirror-"));
  roots.push(root);
  const payload = Buffer.from([1, 4, 9, 16]);
  const collection = "c".repeat(64);
  const repository = "example/homebrew-tap";
  const tag = `homebrew-shell-bottles-sha256-${collection}`;
  const releaseRoot = `https://github.com/${repository}/releases/download/${tag}`;
  const asset = "kandelo-homebrew-bottle-test-layer.bin";
  const plan = {
    schema: 1,
    kind: "kandelo-homebrew-bottle-mirror-plan",
    repository,
    collection_sha256: collection,
    tag,
    release_root: releaseRoot,
    manifest_asset: "kandelo-homebrew-bottle-mirror-plan.json",
    assets: [{
      id: "bottle-test",
      package: "example/tap/test",
      asset,
      sha256: sha256(payload),
      bytes: payload.byteLength,
      url: `${releaseRoot}/${asset}`,
    }],
  };
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const planPath = join(root, "expected-plan.json");
  const receiptPath = join(root, "receipt.json");
  writeFileSync(planPath, planBytes);
  return {
    assetUrl: plan.assets[0].url,
    payload,
    plan,
    planBytes,
    planPath,
    planUrl: `${releaseRoot}/${plan.manifest_asset}`,
    receiptPath,
  };
}

function fixtureFetch(value, overrides = {}) {
  const calls = [];
  const fetchImpl = async (input, init) => {
    const url = input.toString();
    calls.push({ url, init });
    if (url === value.planUrl) {
      return overrides.planResponse ?? new Response(value.planBytes);
    }
    if (url === value.assetUrl) {
      return overrides.assetResponse ?? new Response(value.payload);
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

test("pins the exact recovered 37-asset rollout plan", () => {
  const bytes = readFileSync(checkedInPlanUrl);
  const plan = JSON.parse(bytes.toString("utf8"));

  assert.equal(bytes.byteLength, 19_901);
  assert.equal(
    sha256(bytes),
    "0eaf1454cd94eeddf45fe508e6a727f75344398540c5f84f33b85a9509b988ff",
  );
  assert.equal(plan.repository, "kandelo-dev/homebrew-tap-core");
  assert.equal(
    plan.collection_sha256,
    "d5aa52c246ccb9a93751ef2c57c93e18a798cc1637ddd57f921fea957a61f48b",
  );
  assert.equal(plan.assets.length, 37);
  assert.equal(
    plan.assets.reduce((total, asset) => total + asset.bytes, 0),
    48_116_392,
  );
  assert.equal(Math.max(...plan.assets.map((asset) => asset.bytes)), 11_347_489);
});

test("anonymously verifies the checked-in plan and every exact public asset", async () => {
  const value = fixture();
  const transport = fixtureFetch(value);

  const receipt = await verifyPublicHomebrewBottleMirror({
    planPath: value.planPath,
    outputPath: value.receiptPath,
    fetchImpl: transport.fetchImpl,
  });

  assert.deepEqual(transport.calls.map(({ url }) => url), [
    value.planUrl,
    value.assetUrl,
  ]);
  for (const { init } of transport.calls) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "follow");
    assert.equal(init.headers, undefined);
  }
  assert.equal(receipt.collection_sha256, value.plan.collection_sha256);
  assert.deepEqual(receipt.assets, [{
    asset: value.plan.assets[0].asset,
    bytes: value.payload.byteLength,
    sha256: sha256(value.payload),
  }]);
  assert.deepEqual(JSON.parse(readFileSync(value.receiptPath, "utf8")), receipt);
});

test("fails retryably when the public plan is missing", async () => {
  const value = fixture();
  const transport = fixtureFetch(value, {
    planResponse: new Response("missing", { status: 404 }),
  });

  await assert.rejects(
    verifyPublicHomebrewBottleMirror({
      planPath: value.planPath,
      outputPath: value.receiptPath,
      fetchImpl: transport.fetchImpl,
    }),
    /public mirror plan is unavailable: HTTP 404/,
  );
  assert.equal(transport.calls.length, 1);
});

test("rejects a public payload with the right size and wrong digest", async () => {
  const value = fixture();
  const transport = fixtureFetch(value, {
    assetResponse: new Response(Buffer.from([16, 9, 4, 1])),
  });

  await assert.rejects(
    verifyPublicHomebrewBottleMirror({
      planPath: value.planPath,
      outputPath: value.receiptPath,
      fetchImpl: transport.fetchImpl,
    }),
    /public mirror asset .* SHA-256 differs/,
  );
});

test("rejects a public payload whose byte count differs", async () => {
  const value = fixture();
  const transport = fixtureFetch(value, {
    assetResponse: new Response(Buffer.from([1, 4, 9])),
  });

  await assert.rejects(
    verifyPublicHomebrewBottleMirror({
      planPath: value.planPath,
      outputPath: value.receiptPath,
      fetchImpl: transport.fetchImpl,
    }),
    /public mirror asset .* byte count differs/,
  );
});

test("rejects a Content-Length above the checked-in byte count", async () => {
  const value = fixture();
  const declaredOversize = new ReadableStream({
    pull(controller) {
      controller.enqueue(value.payload);
      controller.close();
    },
  });
  const transport = fixtureFetch(value, {
    assetResponse: new Response(declaredOversize, {
      headers: { "content-length": String(value.payload.byteLength + 1) },
    }),
  });

  await assert.rejects(
    verifyPublicHomebrewBottleMirror({
      planPath: value.planPath,
      outputPath: value.receiptPath,
      fetchImpl: transport.fetchImpl,
    }),
    /public mirror asset .* exceeds its checked-in byte count/,
  );
});

test("rejects any declared Content-Length that is not the checked-in count", async () => {
  const value = fixture();
  const transport = fixtureFetch(value, {
    assetResponse: new Response(value.payload, {
      headers: { "content-length": String(value.payload.byteLength - 1) },
    }),
  });

  await assert.rejects(
    verifyPublicHomebrewBottleMirror({
      planPath: value.planPath,
      outputPath: value.receiptPath,
      fetchImpl: transport.fetchImpl,
    }),
    /public mirror asset .* Content-Length differs from its checked-in byte count/,
  );
});

test("stops reading a response once it exceeds the checked-in byte count", async () => {
  const value = fixture();
  let cancelled = false;
  const oversized = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1, 4, 9, 16, 25]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const transport = fixtureFetch(value, {
    assetResponse: new Response(oversized),
  });

  await assert.rejects(
    verifyPublicHomebrewBottleMirror({
      planPath: value.planPath,
      outputPath: value.receiptPath,
      fetchImpl: transport.fetchImpl,
    }),
    /public mirror asset .* exceeds its checked-in byte count/,
  );
  assert.equal(cancelled, true);
});

test("rejects a published plan that differs from the checked-in bytes", async () => {
  const value = fixture();
  const changed = Buffer.from(value.planBytes);
  changed[changed.byteLength - 2] = 0x20;
  const transport = fixtureFetch(value, {
    planResponse: new Response(changed),
  });

  await assert.rejects(
    verifyPublicHomebrewBottleMirror({
      planPath: value.planPath,
      outputPath: value.receiptPath,
      fetchImpl: transport.fetchImpl,
    }),
    /published mirror plan differs from the checked-in plan/,
  );
});
