#!/usr/bin/env node
// Cost of the ESSL 3.00 translation (host/src/webgl/essl3-translation.ts),
// which runs once per CompileShader that needs it, never per draw.
// Usage: node tests/graphics/essl3-translation-check/bench.mjs <dir of *.glsl> [engine...]
// Node: standardDerivativesShaderSource + translateEssl100 per source
// (median of 20 runs after warm-up). Engines: for the largest sources, the
// native ES 1.00 compile, the host path (ES 1.00 compile, translation,
// ESSL 3.00 compile) and a lone ESSL 3.00 compile of the translation,
// timed through getShaderParameter(COMPILE_STATUS).
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(join(root, "host/package.json"));
const esbuild = require("esbuild"), playwright = require("playwright");
const [dir, ...engines] = process.argv.slice(2);
const files = readdirSync(dir).filter(f => f.endsWith(".glsl")).map(f => ({ name: f, source: readFileSync(join(dir, f), "utf8"), fragment: f.includes(".Fragment.") }));

const node = await esbuild.build({ stdin: { contents: `export { translateEssl100, standardDerivativesShaderSource } from "./host/src/webgl/essl3-translation.ts";`, resolveDir: root, loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "error" });
const { translateEssl100, standardDerivativesShaderSource } = await import(`data:text/javascript;base64,${Buffer.from(node.outputFiles[0].text).toString("base64")}`);
const median = a => a.sort((x, y) => x - y)[a.length >> 1];
const timed = [];
for (const f of files) {
  for (let i = 0; i < 3; i++) translateEssl100(standardDerivativesShaderSource(f.source), f.fragment);
  const runs = [];
  for (let i = 0; i < 20; i++) { const t = performance.now(); translateEssl100(standardDerivativesShaderSource(f.source), f.fragment); runs.push(performance.now() - t); }
  timed.push({ name: f.name, bytes: f.source.length, ms: median(runs) });
}
timed.sort((a, b) => b.ms - a.ms);
const total = timed.reduce((s, t) => s + t.ms, 0);
console.log(`node ${process.version}: ${timed.length} sources, translation median per source ${median(timed.map(t => t.ms)).toFixed(3)} ms, ` +
  `sum ${total.toFixed(1)} ms; slowest:`);
for (const t of timed.slice(0, 5)) console.log(`  ${t.ms.toFixed(3)} ms  ${t.bytes} bytes  ${t.name}`);

// The largest sources the host path translates (Appendix A only), each
// timed as a loop of repetitions: Firefox and WebKit coarsen
// performance.now() to 1 ms without cross-origin isolation.
const translatable = new Set(files.filter(f => /performance\.shader|stress|loop|tmp_array/.test(f.name)).map(f => f.name));
const largest = [...files].filter(f => translatable.has(f.name)).sort((a, b) => b.source.length - a.source.length).slice(0, 5);
const page = await esbuild.build({ stdin: { contents: `
  import { compileGuestShader, standardDerivativesShaderSource, translateEssl100 } from "./host/src/webgl/essl3-translation.ts";
  window.bench = (shaders, repeat) => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const loop = (fragment, work) => { const shaders = Array.from({ length: repeat }, () => gl.createShader(fragment ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER));
      const t = performance.now(); let last; for (const s of shaders) last = work(s); const ms = (performance.now() - t) / repeat;
      for (const s of shaders) gl.deleteShader(s); return { ms, last }; };
    const compile = (fragment, source) => loop(fragment, s => { gl.shaderSource(s, source); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS); });
    return shaders.map(({ name, source, fragment }) => {
      const prepared = standardDerivativesShaderSource(source), translated = translateEssl100(prepared, fragment).text;
      const t = performance.now(); for (let i = 0; i < repeat; i++) translateEssl100(standardDerivativesShaderSource(source), fragment);
      const translate = (performance.now() - t) / repeat;
      const native = compile(fragment, source), alone = compile(fragment, translated);
      const host = loop(fragment, s => compileGuestShader(gl, s, standardDerivativesShaderSource(source), fragment));
      return { name, bytes: source.length, translate, native100: native.ms, essl300Only: alone.ms, hostPath: host.ms, language: host.last };
    });
  };`, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser", logLevel: "error" });
for (const engine of engines) {
  const options = { headless: true };
  if (engine === "firefox" && process.platform === "darwin") options.env = { ...process.env, CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), "essl3-bench-ff-")) };
  const browser = await playwright[engine].launch(options);
  const p = await browser.newPage();
  await p.setContent("<!doctype html><body></body>");
  await p.addScriptTag({ content: page.outputFiles[0].text });
  const rows = await p.evaluate(([s, n]) => window.bench(s, n), [largest, 40]);
  console.log(`${engine} ${browser.version()} (mean of 40, ms): translation | native ES 1.00 compile (rejected) | ESSL 3.00 compile alone | host path total`);
  for (const r of rows) console.log(`  ${r.translate.toFixed(3)} | ${r.native100.toFixed(2)} | ${r.essl300Only.toFixed(2)} | ${r.hostPath.toFixed(2)}  ${r.bytes} bytes ${r.language} ${r.name}`);
  await browser.close();
}
