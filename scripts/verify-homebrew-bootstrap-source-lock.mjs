import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9]+-g[0-9a-f]{7,40})?$/;
const PORTABLE_RUBY_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:_[0-9]+)?$/;
const TOOL_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function fail(message) {
  throw new Error(`homebrew-bootstrap source lock: ${message}`);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(`${label} fields must be exactly ${wanted.join(", ")}; got ${actual.join(", ")}`);
  }
}

function regularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular non-symlink file: ${path}`);
  }
  return stat;
}

function stringField(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail(`${label} must be a positive safe integer`);
  }
}

export function loadHomebrewBootstrapSourceLock(path) {
  regularFile(path, "lock");
  const lock = JSON.parse(readFileSync(path, "utf8"));
  exactKeys(
    lock,
    ["schema", "kind", "package", "source", "patch", "license", "prepared", "output"],
    "lock",
  );
  if (lock.schema !== 1) fail(`unsupported schema ${lock.schema}`);
  if (lock.kind !== "kandelo-homebrew-bootstrap-source-lock") {
    fail(`unsupported kind ${JSON.stringify(lock.kind)}`);
  }

  exactKeys(lock.package, ["name", "version", "arch"], "package");
  if (lock.package.name !== "homebrew-bootstrap") fail("package.name must be homebrew-bootstrap");
  stringField(lock.package.version, VERSION, "package.version");
  if (lock.package.arch !== "wasm32") fail("package.arch must be wasm32");

  exactKeys(
    lock.source,
    ["repository", "revision", "archive_url", "archive_sha256"],
    "source",
  );
  if (lock.source.repository !== "https://github.com/Homebrew/brew.git") {
    fail("source.repository must be the anonymous upstream Homebrew repository");
  }
  stringField(lock.source.revision, /^[0-9a-f]{40}$/, "source.revision");
  const expectedArchiveUrl =
    `https://github.com/Homebrew/brew/archive/${lock.source.revision}.tar.gz`;
  if (lock.source.archive_url !== expectedArchiveUrl) {
    fail(`source.archive_url must be ${expectedArchiveUrl}`);
  }
  stringField(lock.source.archive_sha256, SHA256, "source.archive_sha256");

  exactKeys(lock.patch, ["path", "sha256"], "patch");
  if (lock.patch.path !== "homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch") {
    fail("patch.path must name the reviewed guest Homebrew patch");
  }
  stringField(lock.patch.sha256, SHA256, "patch.sha256");

  exactKeys(lock.license, ["expression", "upstream", "kandelo_patch"], "license");
  if (lock.license.expression !== "BSD-2-Clause AND GPL-2.0-or-later") {
    fail("license.expression must preserve both reviewed license boundaries");
  }
  exactKeys(
    lock.license.upstream,
    ["spdx", "path", "sha256", "bytes"],
    "license.upstream",
  );
  if (
    lock.license.upstream.spdx !== "BSD-2-Clause" ||
    lock.license.upstream.path !== "LICENSE.txt"
  ) {
    fail("license.upstream must identify Homebrew's exact BSD-2-Clause LICENSE.txt");
  }
  stringField(lock.license.upstream.sha256, SHA256, "license.upstream.sha256");
  positiveSafeInteger(lock.license.upstream.bytes, "license.upstream.bytes");
  exactKeys(
    lock.license.kandelo_patch,
    ["spdx", "evidence_path", "evidence_sha256"],
    "license.kandelo_patch",
  );
  if (
    lock.license.kandelo_patch.spdx !== "GPL-2.0-or-later" ||
    lock.license.kandelo_patch.evidence_path !== "homebrew/patches/README.md"
  ) {
    fail("license.kandelo_patch must identify the documented Kandelo project boundary");
  }
  stringField(
    lock.license.kandelo_patch.evidence_sha256,
    SHA256,
    "license.kandelo_patch.evidence_sha256",
  );

  exactKeys(
    lock.prepared,
    [
      "patched_tree_git_oid",
      "patched_tree_sha256",
      "portable_ruby_version",
      "git_version",
    ],
    "prepared",
  );
  stringField(lock.prepared.patched_tree_git_oid, GIT_OID, "prepared.patched_tree_git_oid");
  stringField(lock.prepared.patched_tree_sha256, SHA256, "prepared.patched_tree_sha256");
  stringField(
    lock.prepared.portable_ruby_version,
    PORTABLE_RUBY_VERSION,
    "prepared.portable_ruby_version",
  );
  stringField(lock.prepared.git_version, TOOL_VERSION, "prepared.git_version");

  exactKeys(
    lock.output,
    ["path", "sha256", "bytes"],
    "output",
  );
  if (lock.output.path !== "homebrew-bootstrap.zip") {
    fail("output.path must be homebrew-bootstrap.zip");
  }
  stringField(lock.output.sha256, SHA256, "output.sha256");
  positiveSafeInteger(lock.output.bytes, "output.bytes");

  return lock;
}

function compareOption(options, name, expected, label = name) {
  if (options.has(name) && options.get(name) !== expected) {
    fail(`${label} mismatch: expected ${expected}, got ${options.get(name)}`);
  }
}

function verifySourceCheckout(lock, sourceCheckout) {
  const checkoutStat = lstatSync(sourceCheckout);
  if (!checkoutStat.isDirectory() || checkoutStat.isSymbolicLink()) {
    fail(`source checkout must be a real directory: ${sourceCheckout}`);
  }
  const versionPath =
    `${sourceCheckout}/Library/Homebrew/vendor/portable-ruby-version`;
  regularFile(versionPath, "portable Ruby version");
  const bytes = readFileSync(versionPath);
  const expected = `${lock.prepared.portable_ruby_version}\n`;
  if (!bytes.equals(Buffer.from(expected))) {
    fail(`source checkout portable Ruby version must be exactly ${JSON.stringify(expected)}`);
  }

  const licensePath = `${sourceCheckout}/${lock.license.upstream.path}`;
  const licenseStat = regularFile(licensePath, "upstream Homebrew license");
  if (licenseStat.size !== lock.license.upstream.bytes) {
    fail(
      `upstream Homebrew license has ${licenseStat.size} bytes, ` +
      `expected ${lock.license.upstream.bytes}`,
    );
  }
  const licenseSha256 = createHash("sha256")
    .update(readFileSync(licensePath))
    .digest("hex");
  if (licenseSha256 !== lock.license.upstream.sha256) {
    fail("upstream Homebrew license SHA-256 mismatch");
  }
}

function verifyLicenseEvidence(lock, evidencePath) {
  regularFile(evidencePath, "Kandelo patch license evidence");
  const sha256 = createHash("sha256")
    .update(readFileSync(evidencePath))
    .digest("hex");
  if (sha256 !== lock.license.kandelo_patch.evidence_sha256) {
    fail("Kandelo patch license evidence SHA-256 mismatch");
  }
}

function verifyProvenance(lock, provenancePath) {
  regularFile(provenancePath, "source provenance");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  exactKeys(
    provenance,
    [
      "schema",
      "homebrew_repository",
      "homebrew_revision",
      "homebrew_patch_sha256",
      "homebrew_patched_tree_git_oid",
      "homebrew_patched_tree_sha256",
      "homebrew_archive_sha256",
      "homebrew_bottle_arch",
      "homebrew_bottle_tag",
    ],
    "source provenance",
  );
  const expected = {
    schema: 1,
    homebrew_repository: lock.source.repository,
    homebrew_revision: lock.source.revision,
    homebrew_patch_sha256: lock.patch.sha256,
    homebrew_patched_tree_git_oid: lock.prepared.patched_tree_git_oid,
    homebrew_patched_tree_sha256: lock.prepared.patched_tree_sha256,
    homebrew_archive_sha256: lock.output.sha256,
    homebrew_bottle_arch: lock.package.arch,
    homebrew_bottle_tag: `${lock.package.arch}_kandelo`,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (provenance[field] !== value) {
      fail(`source provenance ${field} mismatch`);
    }
  }
}

function verifyArchive(lock, archivePath) {
  const stat = regularFile(archivePath, "output archive");
  if (stat.size !== lock.output.bytes) {
    fail(`output archive has ${stat.size} bytes, expected ${lock.output.bytes}`);
  }
  const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (sha256 !== lock.output.sha256) {
    fail(`output archive SHA-256 ${sha256} does not match ${lock.output.sha256}`);
  }
}

export function verifyHomebrewBootstrapSourceLock(lock, options = new Map()) {
  compareOption(options, "package-name", lock.package.name);
  compareOption(options, "package-version", lock.package.version);
  compareOption(options, "target-arch", lock.package.arch);
  compareOption(options, "source-url", lock.source.archive_url);
  compareOption(options, "source-sha256", lock.source.archive_sha256);
  compareOption(options, "git-commit", lock.source.revision);
  compareOption(options, "git-version", lock.prepared.git_version);
  compareOption(options, "patch-path", lock.patch.path);

  if (options.has("source-checkout")) {
    verifySourceCheckout(lock, options.get("source-checkout"));
  }
  if (options.has("license-evidence")) {
    verifyLicenseEvidence(lock, options.get("license-evidence"));
  }
  if (options.has("provenance")) {
    verifyProvenance(lock, options.get("provenance"));
  }
  if (options.has("archive")) {
    verifyArchive(lock, options.get("archive"));
  }
}

const FIELDS = new Map([
  ["package.name", (lock) => lock.package.name],
  ["package.version", (lock) => lock.package.version],
  ["package.arch", (lock) => lock.package.arch],
  ["source.repository", (lock) => lock.source.repository],
  ["source.revision", (lock) => lock.source.revision],
  ["patch.path", (lock) => lock.patch.path],
  ["patch.sha256", (lock) => lock.patch.sha256],
  [
    "license.kandelo_patch.evidence_path",
    (lock) => lock.license.kandelo_patch.evidence_path,
  ],
]);

function usage() {
  console.error(
    "usage: node scripts/verify-homebrew-bootstrap-source-lock.mjs " +
      "--lock <json> [--field <name> | verification options]",
  );
}

function main(argv) {
  const allowed = new Set([
    "lock",
    "field",
    "package-name",
    "package-version",
    "target-arch",
    "source-url",
    "source-sha256",
    "git-commit",
    "git-version",
    "patch-path",
    "license-evidence",
    "source-checkout",
    "provenance",
    "archive",
  ]);
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    if (!allowed.has(name) || options.has(name) || value === undefined) {
      usage();
      process.exitCode = 2;
      return;
    }
    options.set(name, value);
  }
  const lockPath = options.get("lock");
  if (!lockPath) {
    usage();
    process.exitCode = 2;
    return;
  }
  const lock = loadHomebrewBootstrapSourceLock(lockPath);
  if (options.has("field")) {
    if (options.size !== 2) fail("--field cannot be combined with verification options");
    const read = FIELDS.get(options.get("field"));
    if (!read) fail(`unsupported field ${JSON.stringify(options.get("field"))}`);
    process.stdout.write(`${read(lock)}\n`);
    return;
  }
  options.delete("lock");
  verifyHomebrewBootstrapSourceLock(lock, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
