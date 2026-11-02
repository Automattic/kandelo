import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const repository = new URL("../../../", import.meta.url);
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kandelo deploy's spacefast-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "bin", "apps/spacefast-cors-proxy/src"]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  for (const path of ["scripts/deploy-spacefast.mjs", "apps/spacefast-cors-proxy/src/request-policy.ts"]) {
    await copyFile(new URL(path, repository), join(root, path));
  }
  // Replace build/publish executables, exercising the real orchestration
  // without installing tools, compiling the kernel, or touching an account.
  await writeFile(join(root, "run.sh"), `#! /bin/sh
exec ${shellQuote(process.execPath)} ${shellQuote(join(root, "builder.cjs"))} "$@"
`);
  await writeFile(join(root, "builder.cjs"), `
const fs=require('node:fs'), path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync('trace.jsonl',JSON.stringify({tool:'build',args})+'\\n');
if(process.env.FAIL_BUILD)process.exit(17);
const out=args[args.indexOf('--out')+1];fs.mkdirSync(out,{recursive:true});
`);
  await writeFile(join(root, "scripts/dev-shell.sh"), `#! /bin/sh
test "$1" = node || exit 18
shift
exec ${shellQuote(process.execPath)} "$@"
`);
  await writeFile(join(root, "apps/spacefast-cors-proxy/build-site.mjs"), `
import {appendFileSync,mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
appendFileSync('trace.jsonl',JSON.stringify({tool:'package',args})+'\\n');
if(process.env.FAIL_PACKAGE)process.exit(19);
const out=mkdtempSync(join(process.cwd(),'.context/spacefast-kandelo-build-'));
writeFileSync(join(out,'sf.jsonc'),JSON.stringify({runtime:{kind:'functions'}}));
console.log('build shell startup notice');console.log(out);
`);
  await writeFile(join(root, "apps/spacefast-cors-proxy/build-preview-site.mjs"), `
import {appendFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
appendFileSync('trace.jsonl',JSON.stringify({tool:'package-preview',args})+'\\n');
const out=mkdtempSync(join(process.cwd(),'.context/spacefast-kandelo-preview-'));
console.log(out);
`);
  await writeFile(join(root, "bin/sf"), `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync('trace.jsonl',JSON.stringify({tool:'sf',args})+'\\n');
if(args[0]==='--version'){console.log('spacefast/test');process.exit(0);}
if(process.env.FAIL_PUBLISH)process.exit(20);
`, { mode: 0o755 });
  const script = join(root, "scripts/deploy-spacefast.mjs");
  async function trace() {
    try { return (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  async function run(args, extra = {}) {
    return execute(process.execPath, [script, ...args], { cwd: tmpdir(), env: {
      ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
      SPACEFAST_SPACE: "unrelated-saved-selection", ...extra,
    } });
  }
  return { root, run, trace };
}

test("deployment help and invalid targets never build or contact the CLI", async t => {
  const f = await fixture(t);
  assert.match((await f.run(["--help"])).stdout, /Without --publish/);
  for (const args of [[], ["--space"], ["--space", "--publish"], ["--unknown"],
    ["--space", "https://app.example/"], ["--space", "http://app.example"],
    ["--space", "https://app.example/callback?code=do-not-print"],
    ["--space", "https://user:password@app.example"],
    ["--space", "https://*.example"], ["--space", "https://app.example https://other.example"],
    ["--space", "https://app.example", "--allow-referer", "https://alias.example/path"],
    ["--space", "https://app.example", "--allow-referer", "https://*.example"],
    ["--space", "https://app.example", "--space", "https://other.example"],
    ["--space", "https://app.example", "--publish", "--dry-run"]]) {
    await assert.rejects(f.run(args), error => {
      assert.ok(!error.stderr.includes("do-not-print"));
      assert.ok(!error.stderr.includes("password"));
      return true;
    });
  }
  assert.deepEqual(await f.trace(), []);
  assert.ok(!(await readdir(f.root)).includes(".context"));
});

test("an unavailable CLI fails before building and never attempts installation or sign-in", async t => {
  const f = await fixture(t);
  await rm(join(f.root, "bin/sf"));
  await assert.rejects(f.run(["--space", "https://app.example", "--publish"], {
    PATH: join(f.root, "bin"),
  }), /Required command is unavailable: sf/);
  assert.deepEqual(await f.trace(), []);
  assert.ok(!(await readdir(f.root)).includes(".context"));
});

test("preparation uses a unique normal build, approves its target, and never invokes sf", async t => {
  const f = await fixture(t);
  const { stdout } = await f.run(["--space=https://app.example", "--allow-referer", "https://alias.example",
    "--allow-referer", "https://app.example", "--allow-referer", "http://localhost:5401"]);
  const [build, packaged] = await f.trace();
  assert.equal(build.tool, "build");
  const site = build.args[build.args.indexOf("--out") + 1];
  assert.deepEqual(build.args, ["build-browser", "--base", "/", "--out", site,
    "--cors-proxy", "/cors-proxy?url=", "--signalling-url", "/signalling"]);
  assert.ok(site.startsWith(join(f.root, ".context", "spacefast-deploy-")));
  assert.deepEqual(packaged, { tool: "package", args: [site,
    "--allow-referer", "https://app.example", "--allow-referer", "https://alias.example",
    "--allow-referer", "http://localhost:5401"] });
  assert.match(stdout, /Publish this exact bundle: sf 'publish'/);
  assert.ok(!stdout.includes("unrelated-saved-selection"));
  await f.run(["--space", "https://app.example"]);
  const trace = await f.trace();
  assert.notEqual(trace[2].args[trace[2].args.indexOf("--out") + 1], site);
});

for (const mode of ["--dry-run", "--publish"]) {
  test(`${mode} sends the exact generated bundle and explicit target to the CLI`, async t => {
    const f = await fixture(t);
    await f.run(["--space", "https://app.example", mode]);
    const trace = await f.trace();
    assert.deepEqual(trace.map(step => step.tool), ["sf", "build", "package", "sf"]);
    assert.deepEqual(trace[0].args, ["--version"]);
    const args = trace[3].args;
    assert.ok(args[1].startsWith(join(f.root, ".context/spacefast-kandelo-build-")));
    assert.deepEqual(args, ["publish", args[1], "--prebuilt", "--space", "https://app.example", "--wait",
      ...(mode === "--dry-run" ? ["--dry-run"] : [])]);
  });
}

test("build, package and publish failures stop the workflow without a fallback destination", async t => {
  for (const [variable, expected] of [["FAIL_BUILD", ["sf", "build"]],
    ["FAIL_PACKAGE", ["sf", "build", "package"]], ["FAIL_PUBLISH", ["sf", "build", "package", "sf"]]]) {
    const f = await fixture(t);
    await assert.rejects(f.run(["--space", "https://app.example", "--publish"], { [variable]: "1" }), /deployment stopped/);
    assert.deepEqual((await f.trace()).map(step => step.tool), expected);
  }
});

test("a preview Space is built for this app, packaged, and published before the app", async t => {
  const f = await fixture(t);
  await f.run(["--space", "https://app.example", "--preview-space", "https://preview.example", "--dry-run"]);
  const trace = await f.trace();
  assert.deepEqual(trace.map(step => step.tool), ["sf", "build", "package", "package-preview", "sf", "sf"]);
  const site = trace[1].args[trace[1].args.indexOf("--out") + 1];
  assert.deepEqual(trace[1].args.slice(-4), ["--preview-origin", "https://preview.example",
    "--app-origin", "https://app.example"]);
  // The preview Space is never approved for the CORS proxy.
  assert.ok(!trace[2].args.includes("https://preview.example"));
  assert.deepEqual(trace[3].args, [`${site}-preview`, "--app-origin", "https://app.example"]);
  assert.ok(trace[4].args[1].startsWith(join(f.root, ".context/spacefast-kandelo-preview-")));
  assert.deepEqual(trace[4].args.slice(2), ["--prebuilt", "--space", "https://preview.example", "--wait", "--dry-run"]);
  assert.deepEqual(trace[5].args.slice(2), ["--prebuilt", "--space", "https://app.example", "--wait", "--dry-run"]);
});

test("a preview Space must be a separate HTTPS Space that the proxy does not approve", async t => {
  const f = await fixture(t);
  for (const args of [
    ["--space", "https://app.example", "--preview-space", "https://app.example"],
    ["--space", "https://app.example", "--preview-space", "http://preview.example"],
    ["--space", "https://app.example", "--preview-space", "https://preview.example",
      "--allow-referer", "https://preview.example"],
    ["--space", "https://app.example", "--preview-space", "https://a.example", "--preview-space", "https://b.example"],
  ]) {
    await assert.rejects(f.run(args));
  }
  // Guest pages must never spend the proxy's quota as Kandelo, whichever
  // order the flags come in.
  for (const args of [
    ["--space", "https://app.example", "--preview-space", "https://preview.example",
      "--allow-referer", "https://preview.example"],
    ["--space", "https://app.example", "--allow-referer=https://preview.example",
      "--preview-space=https://preview.example"],
  ]) {
    await assert.rejects(f.run(args), error => {
      assert.match(error.stderr, /--preview-space must not be approved for the CORS proxy/);
      return true;
    });
  }
  assert.deepEqual(await f.trace(), []);
});
