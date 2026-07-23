import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadHomebrewBootstrapSourceLock,
  verifyHomebrewBootstrapSourceLock,
} from "../../scripts/verify-homebrew-bootstrap-source-lock.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const packageDir = join(repoRoot, "packages/registry/homebrew-bootstrap");
const lockPath = join(repoRoot, "homebrew/homebrew-bootstrap-source-lock.json");
const projectionPath = join(repoRoot, "packages/registry/program-packages.json");
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kandelo-homebrew-bootstrap-package."));
  temporaryRoots.push(root);
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseMultilineStringArray(source: string, field: string): string[] {
  const match = source.match(new RegExp(`^${field} = \\[\\n([\\s\\S]*?)^\\]$`, "m"));
  if (!match) throw new Error(`missing multiline ${field} array`);
  return [...match[1].matchAll(/^\s*"([^"]+)",$/gm)].map((entry) => entry[1]);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("homebrew-bootstrap package contract", () => {
  it("pins one exact portable recipe, output, license boundary, and sealed Git input", () => {
    const manifest = readFileSync(join(packageDir, "package.toml"), "utf8");
    const build = readFileSync(join(packageDir, "build.toml"), "utf8");
    const lock = loadHomebrewBootstrapSourceLock(lockPath);

    expect(manifest).toContain('kind = "program"');
    expect(manifest).toContain(`name = "${lock.package.name}"`);
    expect(manifest).toContain(`version = "${lock.package.version}"`);
    expect(manifest).toContain(`url = "${lock.source.archive_url}"`);
    expect(manifest).toContain(`sha256 = "${lock.source.archive_sha256}"`);
    expect(manifest).toContain(`spdx = "${lock.license.expression}"`);
    expect(manifest).toContain('name = "homebrew-bootstrap"\nwasm = "homebrew-bootstrap.zip"');
    expect(manifest).toContain('fork_instrumentation = "disabled"');

    expect(build).toContain('name = "homebrew_brew"');
    expect(build).toContain(`repository = "${lock.source.repository}"`);
    expect(build).toContain(`commit = "${lock.source.revision}"`);
    expect(build).toContain('commit = "UNPUBLISHED"');

    const patch = readFileSync(join(repoRoot, lock.patch.path));
    expect(sha256(patch)).toBe(lock.patch.sha256);
    const licenseEvidence = readFileSync(
      join(repoRoot, lock.license.kandelo_patch.evidence_path),
    );
    expect(sha256(licenseEvidence)).toBe(lock.license.kandelo_patch.evidence_sha256);
    expect(lock.license.upstream.spdx).toBe("BSD-2-Clause");
    expect(lock.license.kandelo_patch.spdx).toBe("GPL-2.0-or-later");
  });

  it("declares every byte-producing local file and external commit as cache-key input", () => {
    const build = readFileSync(join(packageDir, "build.toml"), "utf8");
    expect(parseMultilineStringArray(build, "inputs")).toEqual([
      "packages/registry/homebrew-bootstrap/build-homebrew-bootstrap.sh",
      "scripts/package-build-roots.sh",
      "scripts/prepare-homebrew-bootstrap-source.sh",
      "scripts/verify-homebrew-bootstrap-source-lock.mjs",
      "homebrew/homebrew-bootstrap-source-lock.json",
      "homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch",
      "homebrew/patches/README.md",
    ]);
    expect(build.match(/\[\[git_inputs\]\]/g)).toHaveLength(1);
    expect(build).toMatch(
      /\[\[git_inputs\]\]\nname = "homebrew_brew"\nrepository = "https:\/\/github\.com\/Homebrew\/brew\.git"\ncommit = "[0-9a-f]{40}"/,
    );
  });

  it("projects the non-Wasm package output through the ordinary resolver policy", () => {
    const projection = JSON.parse(readFileSync(projectionPath, "utf8"));
    expect(projection.format).toBe("kandelo-program-packages-v2");
    expect(projection.identities["homebrew-bootstrap"]).toBeDefined();
    expect(projection.packages["homebrew-bootstrap"]).toMatchObject({
      arches: ["wasm32"],
      dependencyClosures: { wasm32: [] },
      members: [{
        kind: "output",
        sourceArtifact: "homebrew-bootstrap.zip",
        mirrorPath: "homebrew-bootstrap.zip",
        outputName: "homebrew-bootstrap",
        forkInstrumentation: "disabled",
      }],
    });
  });

  it("rejects source, patch, prepared-tree, and output lock drift", () => {
    const original = JSON.parse(readFileSync(lockPath, "utf8"));
    const mutations: Array<[string, (lock: any) => void]> = [
      ["source archive digest", (lock) => { lock.source.archive_sha256 = "not-a-digest"; }],
      ["patch path", (lock) => { lock.patch.path = "homebrew/patches/other.patch"; }],
      ["license expression", (lock) => { lock.license.expression = "BSD-2-Clause"; }],
      ["upstream license", (lock) => { lock.license.upstream.sha256 = "not-a-digest"; }],
      ["patch license evidence", (lock) => { lock.license.kandelo_patch.evidence_path = "COPYING"; }],
      ["patched tree", (lock) => { lock.prepared.patched_tree_git_oid = "not-an-oid"; }],
      ["portable Ruby", (lock) => { lock.prepared.portable_ruby_version = "../ruby"; }],
      ["Git version", (lock) => { lock.prepared.git_version = "latest"; }],
      ["output byte count", (lock) => { lock.output.bytes = 0; }],
    ];

    for (const [label, mutate] of mutations) {
      const root = temporaryRoot();
      const candidate = structuredClone(original);
      mutate(candidate);
      const candidatePath = join(root, "lock.json");
      writeJson(candidatePath, candidate);
      expect(
        () => loadHomebrewBootstrapSourceLock(candidatePath),
        label,
      ).toThrow(/homebrew-bootstrap source lock/);
    }
  });

  it("verifies checkout runtime identity, prepared provenance, output bytes, and caller inputs", () => {
    const root = temporaryRoot();
    const archive = Buffer.from("deterministic bootstrap fixture\n");
    const upstreamLicense = Buffer.from("BSD-2-Clause fixture\n");
    const patchLicenseEvidence = Buffer.from("GPL-2.0-or-later fixture\n");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.output.sha256 = sha256(archive);
    lock.output.bytes = archive.byteLength;
    lock.license.upstream.sha256 = sha256(upstreamLicense);
    lock.license.upstream.bytes = upstreamLicense.byteLength;
    lock.license.kandelo_patch.evidence_sha256 = sha256(patchLicenseEvidence);

    const candidateLockPath = join(root, "lock.json");
    const archivePath = join(root, "homebrew-bootstrap.zip");
    const provenancePath = join(root, "homebrew-source.json");
    const licenseEvidencePath = join(root, "patch-license.md");
    const checkout = join(root, "source");
    const portableRubyPath = join(
      checkout,
      "Library/Homebrew/vendor/portable-ruby-version",
    );
    writeJson(candidateLockPath, lock);
    mkdirSync(dirname(portableRubyPath), { recursive: true });
    writeFileSync(portableRubyPath, `${lock.prepared.portable_ruby_version}\n`);
    writeFileSync(join(checkout, lock.license.upstream.path), upstreamLicense);
    writeFileSync(licenseEvidencePath, patchLicenseEvidence);
    writeFileSync(archivePath, archive);
    writeJson(provenancePath, {
      schema: 1,
      homebrew_repository: lock.source.repository,
      homebrew_revision: lock.source.revision,
      homebrew_patch_sha256: lock.patch.sha256,
      homebrew_patched_tree_git_oid: lock.prepared.patched_tree_git_oid,
      homebrew_patched_tree_sha256: lock.prepared.patched_tree_sha256,
      homebrew_archive_sha256: lock.output.sha256,
      homebrew_bottle_arch: lock.package.arch,
      homebrew_bottle_tag: `${lock.package.arch}_kandelo`,
    });

    const validated = loadHomebrewBootstrapSourceLock(candidateLockPath);
    const options = new Map([
      ["package-name", lock.package.name],
      ["package-version", lock.package.version],
      ["target-arch", lock.package.arch],
      ["source-url", lock.source.archive_url],
      ["source-sha256", lock.source.archive_sha256],
      ["git-commit", lock.source.revision],
      ["git-version", lock.prepared.git_version],
      ["patch-path", lock.patch.path],
      ["license-evidence", licenseEvidencePath],
      ["source-checkout", checkout],
      ["provenance", provenancePath],
      ["archive", archivePath],
    ]);
    expect(() => verifyHomebrewBootstrapSourceLock(validated, options)).not.toThrow();

    const wrongGit = new Map(options);
    wrongGit.set("git-version", "0.0.0");
    expect(() => verifyHomebrewBootstrapSourceLock(validated, wrongGit)).toThrow(
      /git-version mismatch/,
    );

    writeFileSync(archivePath, "changed\n");
    expect(() => verifyHomebrewBootstrapSourceLock(validated, options)).toThrow(
      /output archive has .* bytes|output archive SHA-256/,
    );
    writeFileSync(archivePath, archive);

    writeFileSync(portableRubyPath, "0.0.0\n");
    expect(() => verifyHomebrewBootstrapSourceLock(validated, options)).toThrow(
      /portable Ruby version/,
    );
    writeFileSync(portableRubyPath, `${lock.prepared.portable_ruby_version}\n`);

    writeFileSync(licenseEvidencePath, "changed\n");
    expect(() => verifyHomebrewBootstrapSourceLock(validated, options)).toThrow(
      /patch license evidence SHA-256/,
    );
  });
});
