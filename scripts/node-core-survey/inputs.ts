import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createSourceOnlyBinarySnapshotSession } from "../../host/src/binary-resolver";
import { normalizeImageOwnedLazyReference, resolveImageOwnedLazyAsset } from "../../host/src/vfs/vfs-asset-group-reference";
import { extractZipEntryBounded, parseZipCentralDirectory } from "../../host/src/vfs/zip";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import type { runGuestShard } from "./guest-shard";
import type { PeerFixtures } from "./peer-https";

const root = fileURLToPath(new URL("../../", import.meta.url));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function loadInputs(preparedPath: string, lazyAssetDirectory: string) {
  const preflightOnly = preparedPath === "--preflight";
  const binaryRoot = resolve(process.env.KANDELO_NODE_SURVEY_BINARY_ROOT ?? join(root, "local-binaries"));
  const partialRoot = join(binaryRoot, "partial");
  process.env.WASM_POSIX_RESOLUTION_POLICY = "source-only-v1";
  process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = join(binaryRoot, "source-only-v1");
  const manifest = JSON.parse(readFileSync(join(partialRoot, "partial.json"), "utf8"));
  if (manifest.image !== "shell" || basename(manifest.file) !== manifest.file ||
      !manifest.selection.includes("node-browser-bundle") ||
      (!preflightOnly && !manifest.selection.includes("python-browser-bundle"))) {
    throw new Error("Expected the designated partial shell with its selected test packages");
  }
  const image = readFileSync(join(partialRoot, manifest.file));
  if (digest(image) !== manifest.sha256) throw new Error("Partial shell image digest changed");

  const fs = KandeloImageFs.create();
  fs.loadImage(image);
  const lazy = fs.lazyEntries();
  const addresses = new Set([
    ...lazy.files.filter(file => file.archiveId === 0).map(file => file.uri),
    ...lazy.archives.map(archive => archive.uri),
  ]);
  const members = [...addresses].map(address => ({
    path: normalizeImageOwnedLazyReference(address).slice("assets/".length),
    url: resolveImageOwnedLazyAsset(lazyAssetDirectory, address)!,
  }));
  const snapshots = createSourceOnlyBinarySnapshotSession().snapshots(
    ["kernel.wasm", ...members.map(member => member.path)], 256 * 1024 * 1024,
  );
  const kernel = snapshots[0];
  if (!kernel) throw new Error("SourceOnly projection does not supply this worktree's kernel");
  const assets = members.map(({ path, url }, index) => {
    const snapshot = snapshots[index + 1];
    if (!snapshot) throw new Error(`SourceOnly projection is missing lazy asset ${path}`);
    return { path, url, bytes: snapshot.bytes, size: snapshot.bytes.length, sha256: snapshot.sha256 };
  });
  const nodeArchive = assets.find(asset => asset.path === "programs/wasm32/spidermonkey-node.zip");
  if (!nodeArchive) {
    throw new Error("Partial shell does not reference the standard installed Node bundle");
  }
  const nodeDirectory = parseZipCentralDirectory(nodeArchive.bytes);
  const nodePayloads = [
    "bin/spidermonkey-node", "lib/libnode-amaro.so", "lib/libnode-undici-llhttp.so",
  ].map(name => {
    const entry = nodeDirectory.find(row => row.fileName === name);
    if (!entry) throw new Error(`Missing Node bundle member ${name}`);
    const bytes = extractZipEntryBounded(nodeArchive.bytes, entry, entry.uncompressedSize);
    return { name, size: bytes.length, sha256: digest(bytes) };
  });

  let shard;
  let prepared;
  let observerSha256;
  if (!preflightOnly) {
    prepared = JSON.parse(readFileSync(join(preparedPath, "inputs.json"), "utf8"));
    const fixtures = readFileSync(join(preparedPath, "fixtures.tar"));
    if (digest(fixtures) !== prepared.fixtureArchiveSha256) throw new Error("Fixture archive digest changed");
    const observer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "observe.py"));
    observerSha256 = digest(observer);
    const selectors = [...new Set<string>(prepared.shard.cases.map((row: { selector: string }) => row.selector))];
    shard = { fixtures, observer, selectors };
  }
  const identity = {
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    image: manifest, kernelSha256: kernel.sha256, nodePayloads,
    harnessSha256: Object.fromEntries(["inputs.ts", "guest-shard.ts"].map(name => [
      name, digest(readFileSync(new URL(name, import.meta.url))),
    ])),
    lazyAssets: assets.map(({ path, sha256, size }) => ({ path, sha256, size })),
    prepared, observerSha256,
  };
  return { identity, image, kernel, assets, shard };
}

export function fileDigest(name: string) {
  return digest(readFileSync(new URL(name, import.meta.url)));
}

export function loadPeerFixtures(directory: string) {
  const fixtures = {
    program: readFileSync(new URL("supplemental/peer-fetch.mjs", import.meta.url)),
    certificate: readFileSync(join(directory, "peer-cert.pem")),
    key: readFileSync(join(directory, "peer-key.pem")),
  } satisfies PeerFixtures;
  const fixtureSha256 = Object.fromEntries(Object.entries(fixtures).map(([name, bytes]) => [name, digest(bytes)]));
  return { fixtures, fixtureSha256 };
}

export function writeGuestReport(report: string, result: Awaited<ReturnType<typeof runGuestShard>>) {
  const { observations, ...transport } = result;
  if (observations !== null) writeFileSync(join(report, "observations.jsonl"), observations);
  writeFileSync(join(report, "transport.json"), JSON.stringify(transport, null, 2) + "\n");
}
