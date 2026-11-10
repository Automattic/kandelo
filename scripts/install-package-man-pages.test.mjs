import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(repoRoot, "scripts/install-package-man-pages.sh");

/** Run one helper function in a throwaway work/out dir. */
function run(fn, args) {
  const root = mkdtempSync(join(tmpdir(), "man-helper-"));
  const work = join(root, "work");
  const out = join(root, "out");
  mkdirSync(work);
  mkdirSync(out);
  const script = `
set -euo pipefail
source "${helper}"
${fn} "$@"
`;
  try {
    const stdout = execFileSync("bash", ["-c", script, "_", ...args], {
      env: {
        ...process.env,
        WASM_POSIX_DEP_WORK_DIR: work,
        WASM_POSIX_DEP_OUT_DIR: out,
        WASM_POSIX_DEP_TARGET_ARCH: "wasm32",
      },
      stdio: "pipe",
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "", out, root };
  } catch (error) {
    return { status: error.status ?? 1, stderr: String(error.stderr), out, root };
  }
}

const install = (args) => run("install_package_man_pages", args);

function fixtureTree(files) {
  const tree = mkdtempSync(join(tmpdir(), "man-tree-"));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(tree, dirname(path)), { recursive: true });
    writeFileSync(join(tree, path), body);
  }
  return tree;
}

function listing(out) {
  return execFileSync("unzip", ["-Z", "-l", join(out, "demo-docs.zip")], {
    encoding: "utf8",
  });
}

const PAGE = ".TH DEMO 1\n.SH NAME\ndemo \\- a page\n";

describe("install_package_man_pages", () => {
  it("fails loudly when a named page is missing", () => {
    const tree = fixtureTree({ "doc/other.1": PAGE });
    const result = install(["demo-docs", tree, "doc/demo.1"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/expected man page missing/);
  });

  it("rejects a package name that could escape the work directory", () => {
    const tree = fixtureTree({ "doc/demo.1": PAGE });
    const result = install(["../escape", tree, "doc/demo.1"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/invalid package name/);
    // "../escape" is what $stage/$archive would have been built from below
    // $work, so a validation regression would create these one level above
    // $work -- at the root of this run's throwaway directory.
    expect(existsSync(join(result.root, "escape-stage"))).toBe(false);
    expect(existsSync(join(result.root, "escape.zip"))).toBe(false);
  });

  it("rejects a package name containing a path separator", () => {
    const tree = fixtureTree({ "doc/demo.1": PAGE });
    const result = install(["sub/pkg", tree, "doc/demo.1"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/invalid package name/);
  });

  it("fails when no pages are named at all", () => {
    const tree = fixtureTree({ "doc/demo.1": PAGE });
    const result = install(["demo-docs", tree]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/usage/);
  });

  it("fails when a destination name carries no man section", () => {
    const tree = fixtureTree({ "doc/demo.txt": PAGE });
    const result = install(["demo-docs", tree, "doc/demo.txt"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/cannot infer a man section/);
  });

  it("installs the archive under the docs package's own name", () => {
    const tree = fixtureTree({ "doc/demo.1": PAGE });
    const result = install(["demo-docs", tree, "doc/demo.1"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(existsSync(join(result.out, "demo-docs.zip"))).toBe(true);
  });

  it("honours an explicit rename and takes the section from the new name", () => {
    const tree = fixtureTree({ "less.nro": PAGE, "doc/magic.man": PAGE });
    const result = install([
      "demo-docs",
      tree,
      "less.nro:less.1",
      "doc/magic.man:magic.5",
    ]);
    expect(result.status).toBe(0);
    const entries = listing(result.out);
    expect(entries).toMatch(/share\/man\/man1\/less\.1/);
    expect(entries).toMatch(/share\/man\/man5\/magic\.5/);
  });

  it("links an alias name to a page staged in the same section", () => {
    const tree = fixtureTree({ "src/xz.1": PAGE });
    const result = install(["demo-docs", tree, "src/xz.1", "unxz.1=xz.1"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    // A symlink entry: mode lrwx..., and its body is the relative target.
    expect(listing(result.out)).toMatch(/^l\S+ .* share\/man\/man1\/unxz\.1$/m);
  });

  it("refuses an alias whose target was not staged first", () => {
    const tree = fixtureTree({ "src/xz.1": PAGE });
    const result = install(["demo-docs", tree, "unxz.1=xz.1", "src/xz.1"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not a page staged earlier/);
  });

  it("refuses an alias that points outside its section", () => {
    const tree = fixtureTree({ "src/xz.1": PAGE });
    const result = install(["demo-docs", tree, "src/xz.1", "unxz.1=../man5/xz.1"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/same section/);
  });

  it("produces byte-identical archives across two runs", () => {
    const files = { "doc/demo.1": PAGE, "doc/demo.5": PAGE };
    const args = ["doc/demo.1", "doc/demo.5", "alias.1=demo.1"];
    const first = install(["demo-docs", fixtureTree(files), ...args]);
    const second = install(["demo-docs", fixtureTree(files), ...args]);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const sha = (dir) =>
      createHash("sha256")
        .update(readFileSync(join(dir, "demo-docs.zip")))
        .digest("hex");
    expect(sha(first.out)).toBe(sha(second.out));
  });
});

describe("kandelo_man_pages_substitute", () => {
  it("replaces every occurrence of each token literally", () => {
    const tree = fixtureTree({
      "grep.in.1": '.TH GREP 1 "" "GNU grep @VERSION@"\n@VERSION@ & @VERSION@\n',
    });
    const result = run("kandelo_man_pages_substitute", [
      join(tree, "grep.in.1"),
      join(tree, "grep.1"),
      "@VERSION@=3.11 & /x",
    ]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(readFileSync(join(tree, "grep.1"), "utf8")).toBe(
      '.TH GREP 1 "" "GNU grep 3.11 & /x"\n3.11 & /x & 3.11 & /x\n',
    );
  });

  it("accepts an empty value", () => {
    const tree = fixtureTree({ "php.1.in": ".TH @program_prefix@php 1\n" });
    const result = run("kandelo_man_pages_substitute", [
      join(tree, "php.1.in"),
      join(tree, "php.1"),
      "@program_prefix@=",
    ]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(tree, "php.1"), "utf8")).toBe(".TH php 1\n");
  });

  it("fails when the template no longer contains a token", () => {
    const tree = fixtureTree({ "grep.in.1": ".TH GREP 1\n" });
    const result = run("kandelo_man_pages_substitute", [
      join(tree, "grep.in.1"),
      join(tree, "grep.1"),
      "@VERSION@=3.11",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/has no '@VERSION@'/);
  });
});

describe("kandelo_man_pages_release_date", () => {
  const dates = ["1.11=2025-01-02", "1.12=2026-05-25"];

  it("prints the date recorded for the version", () => {
    const result = run("kandelo_man_pages_release_date", ["1.12", ...dates]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("2026-05-25\n");
  });

  it("fails when the version has no recorded date", () => {
    const result = run("kandelo_man_pages_release_date", ["1.13", ...dates]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no release date recorded for version 1\.13/);
  });

  it("rejects a date that is not YYYY-MM-DD", () => {
    const result = run("kandelo_man_pages_release_date", ["1.12", "1.12=May 25"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/is not YYYY-MM-DD/);
  });
});
