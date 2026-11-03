#!/usr/bin/env node
// Compile, link and draw the host's GLSL rewrites with each engine's real
// WebGL 2 compiler (headless Chromium, Firefox and WebKit via Playwright).
// Usage: node tests/graphics/shader-rewrite-check/run.mjs [output-dir] [engine...]
// Writes <output-dir>/<engine>.json (default: $TMPDIR/kandelo-shader-rewrite-check)
// and exits nonzero if any check fails. "inconclusive" results are checks the
// engine also fails on unrewritten shaders (a recorded "engine-defect" control).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(join(root, "host/package.json"));
const esbuild = require("esbuild");
const playwright = require("playwright");

const [outArg, ...engineArgs] = process.argv.slice(2);
const out = resolve(outArg ?? join(tmpdir(), "kandelo-shader-rewrite-check"));
const engines = engineArgs.length ? engineArgs : ["chromium", "firefox", "webkit"];

const bundle = await esbuild.build({
  entryPoints: [join(here, "checks.ts")], bundle: true, write: false, format: "iife",
  platform: "browser", target: "es2022", logLevel: "error",
});
const script = bundle.outputFiles[0].text;
mkdirSync(out, { recursive: true });

let failed = 0;
for (const engine of engines) {
  const options = { headless: true };
  // Same macOS launch isolation as apps/browser-demos/playwright.config.ts
  // (firefoxLaunchEnv): bundled Firefox otherwise resolves the protected
  // ~/Library/Application Support/Firefox and hangs at launch.
  if (engine === "firefox" && process.platform === "darwin")
    options.env = { ...process.env, CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), "shader-rewrite-firefox-")) };
  const browser = await playwright[engine].launch(options);
  let report;
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    if (process.env.KANDELO_SHADER_REWRITE_PROGRESS === "1") {
      page.on("console", message => { if (message.text().startsWith("shader-check")) console.log(message.text()); });
      await page.evaluate(() => { globalThis.shaderCheckProgress = true; });
    }
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: script });
    report = await page.evaluate(() => window.runShaderRewriteChecks());
    report.engine = engine;
    report.version = browser.version();
    report.pageErrors = errors;
  } finally { await browser.close(); }
  const bad = report.results.filter(r => !r.ok);
  failed += bad.length + report.pageErrors.length;
  const count = status => report.results.filter(r => r.status === status).length;
  report.summary = `${count("pass")} pass, ${count("fail")} fail, ${count("inconclusive")} inconclusive, ` +
    `${count("engine-defect")} engine-defect controls`;
  writeFileSync(join(out, `${engine}.json`), JSON.stringify(report, null, 2) + "\n");
  console.log(`${engine} ${report.version} (${report.renderer}): ${report.summary}`);
  for (const r of report.results.filter(r => r.status !== "pass"))
    console.log(`  ${r.status.toUpperCase()} ${r.name}: ${r.detail}`);
  for (const e of report.pageErrors) console.log(`  PAGE ERROR ${e}`);
}
process.exit(failed ? 1 : 0);
