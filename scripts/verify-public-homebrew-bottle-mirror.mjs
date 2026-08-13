#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLAN_ASSET = "kandelo-homebrew-bottle-mirror-plan.json";
const PLAN_KIND = "kandelo-homebrew-bottle-mirror-plan";

export async function verifyPublicHomebrewBottleMirror(options) {
  const planPath = resolve(options.planPath);
  const outputPath = resolve(options.outputPath);
  assertRegularFile(planPath, "checked-in mirror plan");
  const planBytes = readFileSync(planPath);
  const plan = parsePlan(planBytes);
  const fetchImpl = options.fetchImpl ?? fetch;
  const planUrl = `${plan.release_root}/${PLAN_ASSET}`;
  const publishedPlan = await fetchExact(
    planUrl,
    "public mirror plan",
    planBytes.byteLength,
    fetchImpl,
  );
  if (!publishedPlan.equals(planBytes)) {
    throw new Error("published mirror plan differs from the checked-in plan");
  }

  const verifiedAssets = [];
  for (const asset of plan.assets) {
    const bytes = await fetchExact(
      asset.url,
      `public mirror asset ${asset.asset}`,
      asset.bytes,
      fetchImpl,
    );
    if (bytes.byteLength !== asset.bytes) {
      throw new Error(
        `public mirror asset ${asset.asset} byte count differs: ` +
          `expected ${asset.bytes}, got ${bytes.byteLength}`,
      );
    }
    const digest = sha256(bytes);
    if (digest !== asset.sha256) {
      throw new Error(
        `public mirror asset ${asset.asset} SHA-256 differs: ` +
          `expected ${asset.sha256}, got ${digest}`,
      );
    }
    verifiedAssets.push({
      asset: asset.asset,
      sha256: digest,
      bytes: bytes.byteLength,
    });
  }

  const receipt = {
    schema: 1,
    kind: "kandelo-public-homebrew-bottle-mirror-verification",
    repository: plan.repository,
    tag: plan.tag,
    collection_sha256: plan.collection_sha256,
    plan: {
      url: planUrl,
      sha256: sha256(planBytes),
      bytes: planBytes.byteLength,
    },
    assets: verifiedAssets,
    visibility: "public-anonymous-readback",
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return receipt;
}

async function fetchExact(url, label, maxBytes, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      credentials: "omit",
      redirect: "follow",
    });
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`${label} is unavailable: HTTP ${response.status}`);
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(declaredLength)) {
      await response.body?.cancel();
      throw new Error(`${label} has invalid Content-Length`);
    }
    const declaredBytes = Number(declaredLength);
    if (declaredBytes !== maxBytes) {
      await response.body?.cancel();
      if (declaredBytes > maxBytes) {
        throw new Error(`${label} exceeds its checked-in byte count`);
      }
      throw new Error(
        `${label} Content-Length differs from its checked-in byte count`,
      );
    }
  }
  if (response.body === null) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds its checked-in byte count`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function parsePlan(bytes) {
  let plan;
  try {
    plan = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("checked-in mirror plan is not valid JSON", { cause: error });
  }
  if (
    !isRecord(plan) ||
    plan.schema !== 1 ||
    plan.kind !== PLAN_KIND ||
    typeof plan.repository !== "string" ||
    !/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(plan.repository) ||
    typeof plan.collection_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(plan.collection_sha256) ||
    plan.tag !== `homebrew-shell-bottles-sha256-${plan.collection_sha256}` ||
    plan.release_root !==
      `https://github.com/${plan.repository}/releases/download/${plan.tag}` ||
    plan.manifest_asset !== PLAN_ASSET ||
    !Array.isArray(plan.assets) ||
    plan.assets.length === 0
  ) {
    throw new Error("checked-in mirror plan has invalid identity fields");
  }
  const names = new Set();
  for (const [index, asset] of plan.assets.entries()) {
    if (
      !isRecord(asset) ||
      typeof asset.id !== "string" ||
      typeof asset.package !== "string" ||
      typeof asset.asset !== "string" ||
      names.has(asset.asset) ||
      typeof asset.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.url !== `${plan.release_root}/${asset.asset}`
    ) {
      throw new Error(`checked-in mirror plan asset ${index} is invalid`);
    }
    names.add(asset.asset);
  }
  return plan;
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular non-symlink file: ${path}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArgs(args) {
  if (
    args.length !== 4 ||
    args[0] !== "--plan" ||
    !args[1] ||
    args[2] !== "--out" ||
    !args[3]
  ) {
    throw new Error(
      "usage: node scripts/verify-public-homebrew-bottle-mirror.mjs " +
        "--plan <checked-in-plan.json> --out <new-receipt.json>",
    );
  }
  return { planPath: args[1], outputPath: args[3] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyPublicHomebrewBottleMirror(parseArgs(process.argv.slice(2)));
}
