import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

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
