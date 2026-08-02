import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  type HomebrewTapInputRequirements,
  requireTapInput,
} from "./extract-homebrew-support-data-bottle";
import { filesystemGitTreeOid } from "./homebrew-selection-tree";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the selection tree identity matches Git and changes with bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "kandelo-selection-tree-test-"));
  temporaryRoots.push(root);
  const tap = join(root, "tap");
  mkdirSync(join(tap, "Formula"), { recursive: true });
  mkdirSync(join(tap, "Kandelo"));
  writeFileSync(
    join(tap, "Formula", "alpha.rb"),
    "class Alpha < Formula\nend\n",
  );
  writeFileSync(join(tap, "Kandelo", "metadata.json"), "{}\n");
  writeFileSync(join(tap, "tool"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(tap, "tool"), 0o755);

  execFileSync("git", ["init", "-q", tap]);
  execFileSync("git", ["-C", tap, "add", "."]);
  const expectedTree = execFileSync("git", ["-C", tap, "write-tree"], {
    encoding: "utf8",
  }).trim();
  rmSync(join(tap, ".git"), { recursive: true });
  assert.equal(filesystemGitTreeOid(tap), expectedTree);

  writeFileSync(join(tap, "unexpected"), "substituted\n");
  assert.notEqual(filesystemGitTreeOid(tap), expectedTree);
});

const requirements: HomebrewTapInputRequirements = {
  expectedTapSha: "b".repeat(40),
  expectedTapRepository: "kandelo-dev/homebrew-tap-core",
  expectedTapName: "kandelo-dev/tap-core",
  expectedPackageName: "alpha",
  expectedArch: "wasm32",
  expectedAbi: 42,
};

function makeDetachedTapFixture(): {
  root: string;
  tap: string;
  report: Record<string, unknown>;
} {
  const root = mkdtempSync(join(tmpdir(), "kandelo-selection-auth-test-"));
  temporaryRoots.push(root);
  const tap = join(root, "tap");
  mkdirSync(join(tap, "Formula"), { recursive: true });
  mkdirSync(join(tap, "Kandelo"));
  writeFileSync(
    join(tap, "Formula", "alpha.rb"),
    "class Alpha < Formula\nend\n",
  );
  writeFileSync(
    join(tap, "Kandelo", "metadata.json"),
    '{"kandelo_abi":42,"packages":[{"name":"alpha"}]}\n',
  );
  return {
    root,
    tap,
    report: {
      arch: "wasm32",
      formula_count: 1,
      formulae: ["alpha"],
      kandelo_abi: 42,
      kind: "kandelo-homebrew-closed-selection-verification",
      prepared_tree_git_oid: filesystemGitTreeOid(tap),
      readback: {
        receipt_sha256: "c".repeat(64),
        release_id: 17,
        repository: "kandelo-dev/homebrew-tap-core",
        tag: `homebrew-prefix-selection-sha256-${"d".repeat(64)}`,
        visibility: "public-anonymous-readback",
      },
      roots: ["alpha"],
      schema: 1,
      selection_manifest_sha256: "e".repeat(64),
      source_tap_commit: "b".repeat(40),
      tap_name: "kandelo-dev/tap-core",
    },
  };
}

function writeReport(
  root: string,
  name: string,
  report: Record<string, unknown>,
): string {
  const path = join(root, name);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

test("a generic public-selection report authorizes its exact tap", () => {
  const fixture = makeDetachedTapFixture();
  const report = writeReport(fixture.root, "report.json", fixture.report);
  assert.equal(
    requireTapInput(fixture.tap, requirements, report),
    realpathSync(fixture.tap),
  );
});

test("generic selection authorization rejects substituted identities", () => {
  const mutations: Array<[string, (report: Record<string, unknown>) => void]> =
    [
      ["architecture", (report) => (report.arch = "wasm64")],
      ["ABI", (report) => (report.kandelo_abi = 43)],
      [
        "source commit",
        (report) => (report.source_tap_commit = "a".repeat(40)),
      ],
      ["tap name", (report) => (report.tap_name = "example/other")],
      ["Formula inventory", (report) => (report.formulae = ["beta"])],
      ["Formula count", (report) => (report.formula_count = 2)],
      ["roots", (report) => (report.roots = ["beta"])],
      [
        "repository",
        (report) =>
          ((report.readback as Record<string, unknown>).repository =
            "example/other"),
      ],
      [
        "visibility",
        (report) =>
          ((report.readback as Record<string, unknown>).visibility =
            "authenticated"),
      ],
      [
        "receipt digest",
        (report) =>
          ((report.readback as Record<string, unknown>).receipt_sha256 = "bad"),
      ],
      [
        "release id",
        (report) =>
          ((report.readback as Record<string, unknown>).release_id = 0),
      ],
      [
        "release tag",
        (report) =>
          ((report.readback as Record<string, unknown>).tag = "mutable"),
      ],
      ["extra authority", (report) => (report.unreviewed = true)],
    ];

  for (const [position, [label, mutate]] of mutations.entries()) {
    const fixture = makeDetachedTapFixture();
    const changed = structuredClone(fixture.report);
    mutate(changed);
    const report = writeReport(
      fixture.root,
      `changed-${position}.json`,
      changed,
    );
    assert.throws(
      () => requireTapInput(fixture.tap, requirements, report),
      undefined,
      label,
    );
  }
});

test("generic selection authorization rejects changed tap bytes", () => {
  const fixture = makeDetachedTapFixture();
  const report = writeReport(fixture.root, "report.json", fixture.report);
  writeFileSync(
    join(fixture.tap, "Formula", "alpha.rb"),
    "class Substituted < Formula\nend\n",
  );
  assert.throws(
    () => requireTapInput(fixture.tap, requirements, report),
    /does not authorize this tap input/,
  );
});

test("selection authorization rejects noncanonical and repeated JSON", () => {
  const fixture = makeDetachedTapFixture();
  const compact = join(fixture.root, "compact.json");
  writeFileSync(compact, JSON.stringify(fixture.report));
  assert.throws(
    () => requireTapInput(fixture.tap, requirements, compact),
    /not canonical JSON/,
  );

  const repeated = join(fixture.root, "repeated.json");
  const canonical = JSON.stringify(fixture.report, null, 2);
  writeFileSync(
    repeated,
    canonical.replace('{\n  "arch"', '{\n  "schema": 9,\n  "arch"') + "\n",
  );
  assert.throws(
    () => requireTapInput(fixture.tap, requirements, repeated),
    /not canonical JSON/,
  );
});
