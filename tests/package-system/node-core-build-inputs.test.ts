import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checker = join(repo, "third_party/node-core/check-build-inputs.py");
const temporary: string[] = [];
const core = "third_party/node-core";
const recipe = "packages/registry/spidermonkey/build.toml";
const build = "packages/registry/spidermonkey/build-spidermonkey.sh";

afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

function put(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kandelo-node-inputs-"));
  temporary.push(root);
  put(root, `${core}/sources.json`, JSON.stringify({ modules: { path: { path: "upstream/path.js" } } }));
  put(root, `${core}/adapter.js`, "// Candidate owner\n");
  put(root, `${core}/native-test.cpp`, "// Candidate fragment\n");
  put(root, `${core}/generate-native-embedding.py`, "FRAGMENTS = ('native-test.cpp',)\n");
  put(root, `${core}/upstream/path.js`, "// Pinned reference\n");
  put(root, `${core}/LICENSE`, "license\n");
  put(root, build, '#!/bin/sh\ncp "$REPO_ROOT/third_party/node-core/adapter.js" "$output"\n');
  put(root, recipe, `inputs = ["${core}", "${build}"]\n`);
  return root;
}

function check(root: string) {
  const result = spawnSync("python3", [checker, "--repo-root", root], { encoding: "utf8", timeout: 15_000 });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  return { status: result.status, report: JSON.parse(result.stdout) };
}

describe("Node core declared verification inputs", () => {
  it("covers current production owners and all manifest/unity/shell references", () => {
    const result = check(repo);
    expect(result.status).toBe(0);
    expect(result.report.ok).toBe(true);
    expect(result.report.missingDeclaredInputs).toEqual([]);
    expect(result.report.requiredFiles[`${core}/terminal-platform-adapter.js`]).toContain("core production owner");
    expect(result.report.requiredFiles[`${core}/upstream/terminal/lib/tty.js`]).toContain("manifest reference");
  });

  it("supports resolver directory inputs and a module literally named path", () => {
    expect(check(fixture()).status).toBe(0);
  });

  it("rejects a new computed-name owner omitted from explicit declarations", () => {
    const root = fixture();
    put(root, recipe, `inputs = ["${core}/sources.json", "${core}/generate-native-embedding.py", "${core}/native-test.cpp", "${core}/LICENSE", "${core}/upstream", "${build}"]\n`);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.report.missingDeclaredInputs).toEqual([`${core}/adapter.js`]);
  });

  it("rejects a missing reference even when the parent directory is declared", () => {
    const root = fixture();
    rmSync(join(root, `${core}/upstream/path.js`));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.report.error).toContain("Missing or escaping manifest reference");
  });

  it("rejects an undeclared new nested manifest reference", () => {
    const root = fixture();
    put(root, `${core}/upstream/new.js`, "// New pinned input\n");
    put(root, `${core}/sources.json`, JSON.stringify({ nested: [{ path: "upstream/new.js" }] }));
    put(root, recipe, `inputs = ["${core}/sources.json", "${core}/adapter.js", "${core}/generate-native-embedding.py", "${core}/native-test.cpp", "${core}/LICENSE", "${core}/upstream/path.js", "${build}"]\n`);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.report.missingDeclaredInputs).toEqual([`${core}/upstream/new.js`]);
  });

  it("rejects a missing native unity fragment", () => {
    const root = fixture();
    put(root, `${core}/generate-native-embedding.py`, "FRAGMENTS = ('missing.cpp',)\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.report.error).toContain("Missing or escaping unity fragment");
  });

  it("rejects traversal in a manifest reference", () => {
    const root = fixture();
    put(root, `${core}/sources.json`, JSON.stringify({ nested: { path: "../outside.js" } }));
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.report.error).toContain("Noncanonical repository input path");
  });

  it("requires an actual directory before treating an input as a subtree", () => {
    const root = fixture();
    put(root, recipe, `inputs = ["third_party/node", "${build}"]\n`);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.report.missingDeclaredInputs).toContain(`${core}/adapter.js`);
  });

  it("keys literal generator reads outside the production root extensions", () => {
    const root = fixture();
    put(root, `${core}/extra.py`, "value = (root / 'licenses/extra.txt').read_text()\n");
    put(root, `${core}/licenses/extra.txt`, "license\n");
    put(root, recipe, `inputs = ["${core}/sources.json", "${core}/adapter.js", "${core}/generate-native-embedding.py", "${core}/native-test.cpp", "${core}/LICENSE", "${core}/extra.py", "${core}/upstream", "${build}"]\n`);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.report.missingDeclaredInputs).toEqual([`${core}/licenses/extra.txt`]);
  });

  it("keys literal shell reads outside the production root extensions", () => {
    const root = fixture();
    put(root, `${core}/extra.txt`, "build input\n");
    put(root, build, 'cp "$REPO_ROOT/third_party/node-core/extra.txt" "$output"\n');
    put(root, recipe, `inputs = ["${core}/sources.json", "${core}/adapter.js", "${core}/generate-native-embedding.py", "${core}/native-test.cpp", "${core}/LICENSE", "${core}/upstream", "${build}"]\n`);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.report.missingDeclaredInputs).toEqual([`${core}/extra.txt`]);
  });

  it("rejects a stale bundle without regenerating the checkout", () => {
    const root = fixture();
    cpSync(join(repo, core), join(root, core), { recursive: true });
    for (const relative of [
      "packages/registry/node-compat/target.json",
      "packages/registry/node-compat/bootstrap.js",
      "packages/registry/spidermonkey/patches/0043-kandelo-node-stream-iter.patch",
      "packages/registry/spidermonkey/patches/0044-kandelo-node-codec-backend.patch",
    ]) put(root, relative, readFileSync(join(repo, relative), "utf8"));
    const bundle = join(root, core, "node-core.js");
    const stale = readFileSync(bundle, "utf8") + "\n// Deliberately stale fixture\n";
    writeFileSync(bundle, stale);
    const result = spawnSync("python3", [join(root, core, "build.py"), "--check"], {
      encoding: "utf8", timeout: 15_000,
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Node core bundle needs regeneration");
    expect(readFileSync(bundle, "utf8")).toBe(stale);
  });

  it("runs source preflights before staging engine sources", () => {
    const source = readFileSync(join(repo, build), "utf8");
    const inputs = source.indexOf('python3 "$REPO_ROOT/third_party/node-core/check-build-inputs.py"');
    const freshness = source.indexOf('python3 "$REPO_ROOT/third_party/node-core/build.py" --check');
    const staging = source.indexOf("kandelo_package_stage_primary_source");
    expect(inputs).toBeGreaterThan(0);
    expect(freshness).toBeGreaterThan(inputs);
    expect(staging).toBeGreaterThan(freshness);
  });
});
