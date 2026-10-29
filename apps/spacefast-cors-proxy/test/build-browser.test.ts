import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const execute = promisify(execFile);
const repository = new URL("../../../", import.meta.url);
const run = await readFile(new URL("run.sh", repository), "utf8");
// Exercise the real deployment command, replacing only the expensive build
// tools. Production builds separately verify the VFS/Vite artifact contract.
const command = run.slice(run.indexOf("cmd_build_browser() {"), run.indexOf("\ncmd_browser() {"));
const piplet = await readFile(new URL("apps/signalling/piplet.php", repository));

async function build(t: { after: (fn: () => Promise<unknown>) => void },
  variables: Record<string, string> = {}, args: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), "kandelo-browser-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["bin", "scripts", "apps/signalling", "apps/browser-demos/node_modules"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, "apps/signalling/piplet.php"), piplet);
  // Match the production shell boundary: deployment variables must be
  // explicitly forwarded as command arguments, not inherited accidentally.
  await writeFile(join(root, "scripts/dev-shell.sh"),
    'unset VITE_CORS_PROXY_URL VITE_KANDELO_SIGNALLING_URL\nexec "$@"\n');
  await writeFile(join(root, "bin/node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(root, "bin/npm"), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const out = args[args.indexOf('--outDir') + 1];
fs.mkdirSync(path.join(out, 'vfs-groups'), { recursive: true });
fs.mkdirSync(path.join(out, 'pages/kandelo'), { recursive: true });
for (const name of ['index.html', 'service-worker.js', 'pages/kandelo/viewer.html']) fs.writeFileSync(path.join(out, name), 'built');
if (process.env.KANDELO_PREVIEW_ORIGIN && !process.env.SKIP_PREVIEW_BUNDLE) {
  const preview = process.env.KANDELO_PREVIEW_OUT_DIR;
  fs.mkdirSync(path.join(preview, '__kandelo_preview'), { recursive: true });
  for (const name of ['preview-service-worker.js', '__kandelo_preview/relay.html', '__kandelo_preview/relay.js']) {
    fs.writeFileSync(path.join(preview, name), 'built');
  }
}
fs.writeFileSync(path.join(out, 'deployment.json'), JSON.stringify({
  proxy: process.env.VITE_CORS_PROXY_URL ?? null,
  signalling: process.env.VITE_KANDELO_SIGNALLING_URL ?? null,
  base: process.env.VITE_BASE,
  ...(process.env.KANDELO_PREVIEW_ORIGIN ? {
    previewOrigin: process.env.KANDELO_PREVIEW_ORIGIN,
    appOrigin: process.env.KANDELO_APP_ORIGIN,
    previewOut: process.env.KANDELO_PREVIEW_OUT_DIR,
  } : {}),
}));
`, { mode: 0o755 });
  const env = { ...process.env, ...variables, PATH: `${join(root, "bin")}:${process.env.PATH}` };
  for (const name of ["VITE_CORS_PROXY_URL", "VITE_KANDELO_SIGNALLING_URL"]) {
    if (!(name in variables)) delete env[name];
  }
  await execute("bash", ["-c", `set -euo pipefail
REPO_ROOT="$1"; shift
cmd_prepare_browser() { :; }
step() { :; }
info() { :; }
warn() { :; }
err() { echo "$*" >&2; }
${command}
cmd_build_browser --base /candidate/ --out "$REPO_ROOT/output" "$@"
`, "build-browser-test", root, ...args], { env });
  assert.deepEqual(await readFile(join(root, "output/signalling/piplet.php")), piplet);
  return JSON.parse(await readFile(join(root, "output/deployment.json"), "utf8"));
}

test("default static build ships PHP signalling and leaves Vite endpoint defaults unset", async t => {
  assert.deepEqual(await build(t), { proxy: null, signalling: null, base: "/candidate/" });
});

test("exported deployment endpoints cross the isolated build shell", async t => {
  const proxy = "https://proxy.example/?url=";
  assert.deepEqual(await build(t, {
    VITE_CORS_PROXY_URL: proxy, VITE_KANDELO_SIGNALLING_URL: "/custom/piplet.php",
  }), { proxy, signalling: "/custom/piplet.php", base: "/candidate/" });
});

test("Spacefast flags override exported endpoints without evaluating URL contents", async t => {
  const proxy = "https://proxy.example/?url=&literal=$(exit 97)`exit 98`";
  assert.deepEqual(await build(t, {
    VITE_CORS_PROXY_URL: "https://old.example/?", VITE_KANDELO_SIGNALLING_URL: "/old.php",
  }, ["--cors-proxy", proxy, "--signalling-url=/signalling"]),
  { proxy, signalling: "/signalling", base: "/candidate/" });
});

test("either deployment flag can be set independently", async t => {
  assert.deepEqual(await build(t, {}, ["--cors-proxy=/cors-proxy?url="]),
    { proxy: "/cors-proxy?url=", signalling: null, base: "/candidate/" });
  assert.deepEqual(await build(t, {}, ["--signalling-url", "/signalling"]),
    { proxy: null, signalling: "/signalling", base: "/candidate/" });
});

test("explicitly empty exported endpoints retain their Vite override semantics", async t => {
  assert.deepEqual(await build(t, { VITE_CORS_PROXY_URL: "", VITE_KANDELO_SIGNALLING_URL: "" }),
    { proxy: "", signalling: "", base: "/candidate/" });
});

test("empty deployment flags fail instead of selecting a different service", async t => {
  for (const args of [["--cors-proxy="], ["--cors-proxy"], ["--signalling-url="], ["--signalling-url"]]) {
    await assert.rejects(build(t, {}, args), /requires a URL/);
  }
});

test("a preview origin and its app origin build the preview bundle beside the app", async t => {
  const built = await build(t, {}, [
    "--preview-origin", "https://preview.example", "--app-origin=https://app.example",
  ]);
  assert.equal(built.previewOrigin, "https://preview.example");
  assert.equal(built.appOrigin, "https://app.example");
  assert.match(built.previewOut, /\/output-preview$/);
});

test("a preview origin without its app origin, or a missing preview bundle, fails", async t => {
  await assert.rejects(build(t, {}, ["--preview-origin", "https://preview.example"]), /must be given together/);
  await assert.rejects(build(t, {}, ["--app-origin", "https://app.example"]), /must be given together/);
  await assert.rejects(build(t, { SKIP_PREVIEW_BUNDLE: "1" }, [
    "--preview-origin", "https://preview.example", "--app-origin", "https://app.example",
  ]), /output-preview\/preview-service-worker.js is missing/);
});
