import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

// The evidence-class registry must name exactly the files Vitest collects.
// ci-run-test-suite.sh checks this before every Vitest group; this test runs
// the same check so a plain `npx vitest run` from host/ catches drift too.

const repoRoot = resolve(import.meta.dirname, "../..");
const checker = join(repoRoot, "scripts/check-vitest-evidence-classes.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runChecker(root: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("bash", [join(root, "scripts/check-vitest-evidence-classes.sh")], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

// A repository with the checker, a registry, the named files, and a stub
// `npx` that reports `collected` as Vitest's file inventory.
function fixture(rows: string[], files: string[], collected: string[]) {
  const root = mkdtempSync(join(tmpdir(), "kandelo-vitest-evidence-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "host"), { recursive: true });
  copyFileSync(checker, join(root, "scripts/check-vitest-evidence-classes.sh"));
  writeFileSync(
    join(root, "scripts/ci-vitest-evidence-classes.tsv"),
    ["# fixture registry", ...rows].join("\n") + "\n",
  );
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "npx"),
    `#!/usr/bin/env bash\nprintf '%s\\n' ${collected.map((path) => `'${path}'`).join(" ")}\n`,
  );
  chmodSync(join(bin, "npx"), 0o755);
  return { root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

const sourceRow = "host/test/a.test.ts\tsource-only";
const preparedRow = "host/test/b.test.ts\tprepared-product";

describe("Vitest evidence-class registry", () => {
  it("classifies exactly the files Vitest collects", () => {
    const result = runChecker(repoRoot);
    expect(result.stderr + result.stdout).toContain("registry and Vitest inventory agree");
    expect(result.status).toBe(0);
  });

  it("accepts a registry that matches the inventory", () => {
    const { root, env } = fixture(
      [sourceRow, preparedRow],
      ["host/test/a.test.ts", "host/test/b.test.ts"],
      ["test/a.test.ts", "test/b.test.ts"],
    );
    const result = runChecker(root, env);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("rejects a row whose test file no longer exists", () => {
    const { root, env } = fixture(
      [sourceRow, preparedRow, "host/test/deleted.test.ts\tprepared-product"],
      ["host/test/a.test.ts", "host/test/b.test.ts"],
      ["test/a.test.ts", "test/b.test.ts"],
    );
    const result = runChecker(root, env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "stale row at scripts/ci-vitest-evidence-classes.tsv:4: host/test/deleted.test.ts is not a regular file",
    );
  });

  it("rejects a collected test file without a row", () => {
    const { root, env } = fixture(
      [sourceRow, preparedRow],
      ["host/test/a.test.ts", "host/test/b.test.ts", "host/test/new.test.ts"],
      ["test/a.test.ts", "test/b.test.ts", "test/new.test.ts"],
    );
    const result = runChecker(root, env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "unclassified test: Vitest collects host/test/new.test.ts, but scripts/ci-vitest-evidence-classes.tsv has no row for it",
    );
  });

  it("rejects a row for an existing file that Vitest does not collect", () => {
    const { root, env } = fixture(
      [sourceRow, preparedRow],
      ["host/test/a.test.ts", "host/test/b.test.ts"],
      ["test/a.test.ts"],
    );
    const result = runChecker(root, env);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "uncollected row: scripts/ci-vitest-evidence-classes.tsv classifies host/test/b.test.ts",
    );
  });
});
