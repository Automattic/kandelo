import { readFileSync, writeFileSync } from "node:fs";

function usage() {
  console.error(
    "usage: node scripts/write-homebrew-bootstrap-metadata.mjs --source <json> --abi <N> --out <json>",
  );
}

const options = new Map();
const allowed = new Set(["source", "abi", "out"]);
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  const name = flag?.startsWith("--") ? flag.slice(2) : "";
  if (!allowed.has(name) || options.has(name) || value === undefined) {
    usage();
    process.exit(2);
  }
  options.set(name, value);
}

const sourcePath = options.get("source");
const abiText = options.get("abi");
const outputPath = options.get("out");
if (!sourcePath || !abiText || !outputPath) {
  usage();
  process.exit(2);
}

const abi = Number(abiText);
if (!Number.isSafeInteger(abi) || abi < 1) {
  throw new Error(`invalid Kandelo ABI: ${abiText}`);
}

const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const expectedKeys = [
  "homebrew_archive_sha256",
  "homebrew_bottle_arch",
  "homebrew_bottle_tag",
  "homebrew_patch_sha256",
  "homebrew_patched_tree_git_oid",
  "homebrew_patched_tree_sha256",
  "homebrew_repository",
  "homebrew_revision",
  "schema",
].sort();
const actualKeys = Object.keys(source).sort();
if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
  throw new Error(`unexpected Homebrew source provenance fields: ${actualKeys.join(", ")}`);
}

const sha256 = /^[0-9a-f]{64}$/;
for (const field of [
  "homebrew_archive_sha256",
  "homebrew_patch_sha256",
  "homebrew_patched_tree_sha256",
]) {
  if (!sha256.test(source[field])) throw new Error(`${field} is not a SHA-256 digest`);
}
if (source.schema !== 1) throw new Error(`unsupported source provenance schema: ${source.schema}`);
if (typeof source.homebrew_repository !== "string" || source.homebrew_repository.length === 0) {
  throw new Error("homebrew_repository is empty");
}
if (!/^[0-9a-f]{40}$/.test(source.homebrew_revision)) {
  throw new Error("homebrew_revision is not a full SHA-1 commit id");
}
if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(source.homebrew_patched_tree_git_oid)) {
  throw new Error("homebrew_patched_tree_git_oid is not a Git object id");
}
if (!new Set(["wasm32", "wasm64"]).has(source.homebrew_bottle_arch)) {
  throw new Error(`unsupported Homebrew bottle architecture: ${source.homebrew_bottle_arch}`);
}
const expectedTag = `${source.homebrew_bottle_arch}_kandelo`;
if (source.homebrew_bottle_tag !== expectedTag) {
  throw new Error(`Homebrew bottle tag must be ${expectedTag}`);
}

const metadata = {
  ...source,
  schema: 1,
  created_by: "scripts/build-homebrew-bootstrap.sh",
  prefix: "/home/linuxbrew/.linuxbrew",
  kandelo_abi: abi,
  notes: [
    "The pinned upstream Homebrew tree carries the provenance-bound Kandelo platform patch.",
    "The selected bottle tag is loaded by Homebrew itself from /etc/homebrew/brew.env.",
    "Kandelo programs match the current ABI and package output contracts.",
  ],
};
writeFileSync(outputPath, `${JSON.stringify(metadata, null, 2)}\n`);
