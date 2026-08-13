import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  buildHomebrewCompositionDescriptor,
  reissueHomebrewCompositionDescriptor,
} from "./abi-staging-homebrew-composition-descriptor";

const CANDIDATE_REPOSITORY =
  "ghcr.io/kandelo-dev/homebrew-tap-core-abi-9-candidates/hello";
const CANONICAL_REPOSITORY =
  "ghcr.io/kandelo-dev/homebrew-tap-core-abi-9/hello";
const PKG_VERSION = "2.12.1_2";
const PREFIX = "/opt/kandelo/homebrew";
const CELLAR = `${PREFIX}/Cellar`;

test("derives one exact lazy VFS composition descriptor from bottle bytes", async () => {
  const bottle = bottleTar([
    { path: `hello/${PKG_VERSION}/bin/hello`, data: "#!/bin/sh\necho hello\n", mode: 0o755 },
    { path: `hello/${PKG_VERSION}/.brew/hello.rb`, data: "class Hello < Formula\nend\n" },
    { path: `hello/${PKG_VERSION}/INSTALL_RECEIPT.json`, data: "{}\n" },
  ]);
  const sha256 = digest(bottle);
  const candidateUrl = `https://ghcr.io/v2/${CANDIDATE_REPOSITORY.slice("ghcr.io/".length)}/blobs/sha256:${sha256}`;
  const descriptor = await buildHomebrewCompositionDescriptor(
    compositionInput(bottle, candidateUrl),
    bottle,
    { memoryBytes: 16 * 1024 * 1024 },
  );

  assert.equal(descriptor.kind, "kandelo-homebrew-original-bottle-tree");
  assert.equal(descriptor.formula, "hello");
  assert.deepEqual(descriptor.required_by, ["hello"]);
  assert.deepEqual(descriptor.dependencies, ["kandelo-dev/tap-core/ncurses"]);
  assert.deepEqual(descriptor.tree.transports, [
    { kind: "external-https", url: candidateUrl },
  ]);
  assert.equal(descriptor.tree.content.sha256, sha256);
  assert.equal(descriptor.tree.content.bytes, bottle.byteLength);
  assert.ok(
    descriptor.tree.inventory.entries.some(
      (entry: any) => entry.path === "opt/kandelo/homebrew/bin/hello",
    ),
  );
});

test("reissues only the admitted transport without rebuilding bottle contents", async () => {
  const bottle = bottleTar([
    { path: `hello/${PKG_VERSION}/bin/hello`, data: "#!/bin/sh\necho hello\n", mode: 0o755 },
    { path: `hello/${PKG_VERSION}/.brew/hello.rb`, data: "class Hello < Formula\nend\n" },
    { path: `hello/${PKG_VERSION}/INSTALL_RECEIPT.json`, data: "{}\n" },
  ]);
  const sha256 = digest(bottle);
  const candidateUrl = `https://ghcr.io/v2/${CANDIDATE_REPOSITORY.slice("ghcr.io/".length)}/blobs/sha256:${sha256}`;
  const canonicalUrl = `https://ghcr.io/v2/${CANONICAL_REPOSITORY.slice("ghcr.io/".length)}/blobs/sha256:${sha256}`;
  const candidate = await buildHomebrewCompositionDescriptor(
    compositionInput(bottle, candidateUrl),
    bottle,
    { memoryBytes: 16 * 1024 * 1024 },
  );
  const canonical = reissueHomebrewCompositionDescriptor(candidate, {
    bottleBytes: bottle.byteLength,
    bottleSha256: sha256,
    candidateUrl,
    canonicalUrl,
  });

  assert.deepEqual(canonical.tree.transports, [
    { kind: "external-https", url: canonicalUrl },
  ]);
  assert.equal(canonical.tree.content.sha256, candidate.tree.content.sha256);
  assert.equal(canonical.tree.content.bytes, candidate.tree.content.bytes);
  assert.deepEqual(canonical.tree.inventory, candidate.tree.inventory);
  assert.deepEqual(canonical.dependencies, candidate.dependencies);
  assert.equal(JSON.stringify(canonical).includes("-candidates/"), false);
});

test("rejects noncanonical or cross-tap direct dependency identities", async () => {
  const bottle = bottleTar([
    { path: `hello/${PKG_VERSION}/bin/hello`, data: "#!/bin/sh\necho hello\n", mode: 0o755 },
    { path: `hello/${PKG_VERSION}/.brew/hello.rb`, data: "class Hello < Formula\nend\n" },
    { path: `hello/${PKG_VERSION}/INSTALL_RECEIPT.json`, data: "{}\n" },
  ]);
  const sha256 = digest(bottle);
  const candidateUrl = `https://ghcr.io/v2/${CANDIDATE_REPOSITORY.slice("ghcr.io/".length)}/blobs/sha256:${sha256}`;
  for (const dependencies of [
    ["other/tap/ncurses"],
    ["kandelo-dev/tap-core/ncurses", "kandelo-dev/tap-core/ncurses"],
    ["ncurses"],
  ]) {
    const input = compositionInput(bottle, candidateUrl);
    input.dependencies = dependencies;
    await assert.rejects(
      buildHomebrewCompositionDescriptor(input, bottle, {
        memoryBytes: 16 * 1024 * 1024,
      }),
      /dependenc(?:y|ies).*(invalid|canonical)/i,
    );
  }
});

function compositionInput(bottle: Uint8Array, bottleUrl: string): any {
  const sha256 = digest(bottle);
  return {
    schema: 1,
    kind: "kandelo-abi-staging-homebrew-composition-input",
    source: {
      repository: "Automattic/kandelo",
      commit: "1".repeat(40),
      tree: "2".repeat(40),
    },
    tap_source: {
      repository: "kandelo-dev/homebrew-tap-core",
      commit: "3".repeat(40),
      tree: "4".repeat(40),
    },
    formula: {
      name: "hello",
      full_name: "kandelo-dev/tap-core/hello",
      version: "2.12.1",
      pkg_version: PKG_VERSION,
      revision: 2,
      rebuild: 0,
      architecture: "wasm32",
      target_abi: 9,
      normalized_formula_sha256: "5".repeat(64),
    },
    bottle: {
      sha256,
      bytes: bottle.byteLength,
      immutable_reference: `${CANDIDATE_REPOSITORY}@sha256:${sha256}`,
      transport_url: bottleUrl,
    },
    required_by: ["hello"],
    dependencies: ["kandelo-dev/tap-core/ncurses"],
    link_manifest: {
      schema: 1,
      package: "hello",
      version: PKG_VERSION,
      arch: "wasm32",
      kandelo_abi: 9,
      prefix: PREFIX,
      cellar: CELLAR,
      keg: `${CELLAR}/hello/${PKG_VERSION}`,
      bottle: {
        url: bottleUrl,
        sha256,
        bytes: bottle.byteLength,
        cache_key_sha: sha256,
        payload_root: `hello/${PKG_VERSION}`,
      },
      links: [{ type: "symlink", source: "bin/hello", target: "bin/hello" }],
      receipts: [".brew/hello.rb", "INSTALL_RECEIPT.json"],
      env: { PATH_prepend: ["bin"] },
    },
  };
}

interface TarSpec {
  path: string;
  data?: string;
  mode?: number;
}

function bottleTar(entries: TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = new TextEncoder().encode(entry.data ?? "");
    const header = new Uint8Array(512);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, entry.mode ?? 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeOctal(header, 148, 8, checksum);
    header[155] = 0x20;
    chunks.push(header);
    const payload = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
    payload.set(data);
    chunks.push(payload);
  }
  chunks.push(new Uint8Array(1024));
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Uint8Array(gzipSync(tar));
}

function writeString(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error(`test tar field too long: ${value}`);
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeString(target, offset, length, `${value.toString(8).padStart(length - 2, "0")}\0`);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
