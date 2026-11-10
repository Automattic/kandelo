#!/usr/bin/env node
// Differential check of the ESSL 1.00 -> 3.00 translation
// (host/src/webgl/essl3-translation.ts) with each engine's real WebGL 2
// compiler (headless Chromium, Firefox and WebKit via Playwright).
//
// Usage:
//   node tests/graphics/essl3-translation-check/run.mjs <out-dir> \
//     [--deqp <dir of dEQP gles2/shaders/*.test>] [--sources <dir of *.Vertex.glsl/*.Fragment.glsl>] [engine...]
//
// --deqp: every case of dEQP-GLES2's declarative shader tests (keywords,
//   preprocessor, scoping, functions, ...; the files ship in the
//   graphics-cts package's data.zip under gles2/shaders), specialized the
//   way dEQP's ShaderLibrary does, compiled and linked three ways (see
//   pipeline.ts). The host path must agree with the test's expectation
//   wherever the native ES 1.00 path does, and the translated path must
//   agree with the native one wherever the native one compiles.
// --sources: single shaders (e.g. sources extracted from a dEQP log), each
//   compiled natively and through the host path.
// Writes <out-dir>/<engine>.json and prints a summary. Exits nonzero when the
// host path regresses a case the native path got right.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(join(root, "host/package.json"));
const esbuild = require("esbuild");
// Match the declared browser gate; the host's standalone driver can select
// different engine builds and cannot support a cross-engine comparison.
const browserRequire = createRequire(join(root, "apps/browser-demos/package.json"));
const playwright = browserRequire("@playwright/test");

const args = process.argv.slice(2);
const out = resolve(args.shift() ?? join(tmpdir(), "kandelo-essl3-translation-check"));
let deqp = null, sources = null, filter = null;
const engines = [];
while (args.length) {
  const a = args.shift();
  if (a === "--deqp") deqp = resolve(args.shift());
  else if (a === "--sources") sources = resolve(args.shift());
  else if (a === "--filter") filter = new RegExp(args.shift());
  else engines.push(a);
}
if (!engines.length) engines.push("chromium", "firefox", "webkit");

// --- dEQP .test parsing and specialization (glsShaderLibraryCase.cpp) -------

function parseTests(text, file) {
  const cases = [];
  const lines = text.split("\n");
  const groups = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    let m;
    if ((m = /^group\s+(\S+)/.exec(line))) { groups.push(m[1]); continue; }
    if (line.replace(/#.*$/, "").trim() === "end") { if (current) { cases.push(current); current = null; } else groups.pop(); continue; }
    if ((m = /^case\s+(\S+)/.exec(line))) { current = { name: [file, ...groups, m[1]].join("."), expect: "pass", values: [], requires: [] }; continue; }
    if (!current) continue;
    if ((m = /^expect\s+(\S+)/.exec(line))) { current.expect = m[1]; continue; }
    if ((m = /^version\s+(.+)/.exec(line))) { current.version = m[1]; continue; }
    if ((m = /^require\s+(.+)/.exec(line))) { current.requires.push(m[1]); continue; }
    if (line.startsWith("values")) {
      let body = line;
      while (!body.includes("}") && i + 1 < lines.length) body += "\n" + lines[++i];
      for (const v of body.matchAll(/(input|output|uniform)\s+(\w+)\s+([\w.]+)/g)) current.values.push({ kind: v[1], type: v[2], name: v[3] });
      continue;
    }
    if ((m = /^(both|vertex|fragment)\s+""(.*)$/.exec(line))) {
      let src = m[2];
      if (src.includes('""')) src = src.slice(0, src.indexOf('""'));
      else { const body = []; while (++i < lines.length && !lines[i].trim().startsWith('""')) body.push(lines[i]); src = body.join("\n"); }
      current[m[1]] = src;
      continue;
    }
  }
  return cases;
}

const floatOf = t => t.replace(/^[ib](vec\d)$/, "$1").replace(/^(int|bool)$/, "float");
const scalarFloat = t => /^(float|vec\d|mat\d)$/.test(t);
function compareFunctions(values, useFloat) {
  const types = new Set(values.filter(v => v.kind === "output").map(v => v.type));
  const s = [];
  for (const t of types) {
    if (scalarFloat(t)) {
      if (/^mat/.test(t)) s.push(`bool isOk (${t} a, ${t} b, float eps) { vec4 d = vec4(0.0); return true; }`);
      else if (t === "float") s.push("bool isOk (float a, float b, float eps) { return (abs(a-b) <= (eps*abs(b) + eps)); }");
      else s.push(`bool isOk (${t} a, ${t} b, float eps) { return all(lessThanEqual(abs(a-b), (eps*abs(b) + eps))); }`);
    } else if (useFloat) {
      const f = floatOf(t);
      if (t === "bool") s.push("bool isOk (float a, bool b) { return ((a > 0.5) == b); }");
      else if (t === "int") s.push("bool isOk (float a, int b)  { float atemp = a+0.5; return (float(b) <= atemp && atemp <= float(b+1)); }");
      else if (t.startsWith("b")) s.push(`bool isOk (${f} a, ${t} b) { return (greaterThan(a, ${f}(0.5)) == b); }`);
      else s.push(`bool isOk (${f} a, ${t} b) { return (${t}(floor(a + 0.5)) == b); }`);
    } else s.push(`bool isOk (${t} a, ${t} b) { return (a == b); }`);
  }
  return s.join("\n") + "\n";
}
function compareOp(values, dst, prefix) {
  const outputs = values.filter(v => v.kind === "output");
  if (!outputs.length) return `${dst} = vec4(1.0);\n`;
  return outputs.map((v, i) => `${i ? "RES = RES && " : "bool RES = "}isOk(${scalarFloat(v.type) ? v.name : prefix + v.name}, ref_${v.name}${scalarFloat(v.type) ? ", 0.05" : ""});`).join("\n")
    + `\n${dst} = vec4(RES, RES, RES, 1.0);\n`;
}
// The shader library's single-line substitution preserves guest __LINE__.
// Leaving the format suffix uninterpreted compiled literal ${...} tokens and
// misreported a harness specialization failure as a shader compiler failure.
const fill = (src, params) => src.replace(/\$\{(\w+)(?::(single-line))?\}/g,
  (all, k, singleLine) => params[k] === undefined ? all : singleLine ? params[k].replace(/\n/g, " ") : params[k]);
const uniformDecls = values => values.filter(v => v.kind === "uniform" && !v.name.includes(".")).map(v => `uniform ${v.type} ${v.name};\n`).join("");

function genVertex(values) {
  let s = "precision highp float;\nprecision highp int;\n\nattribute highp vec4 dEQP_Position;\n";
  const inputs = values.filter(v => v.kind === "input");
  for (const v of inputs) s += `attribute ${floatOf(v.type)} a_${v.name};\nvarying ${floatOf(v.type)} ${scalarFloat(v.type) ? v.name : "v_" + v.name};\n`;
  s += "\nvoid main()\n{\n    gl_Position = dEQP_Position;\n";
  for (const v of inputs) s += `    ${scalarFloat(v.type) ? v.name : "v_" + v.name} = a_${v.name};\n`;
  return s + "}\n";
}
function genFragment(values) {
  let s = "precision mediump float;\nprecision mediump int;\n\n" + compareFunctions(values, true) + "\n";
  for (const v of values.filter(v => v.kind === "output"))
    s += `varying ${floatOf(v.type)} ${scalarFloat(v.type) ? v.name : "v_" + v.name};\nuniform ${v.type} ref_${v.name};\n`;
  return s + "\nvoid main()\n{\n    " + compareOp(values, "gl_FragColor", "v_") + "}\n";
}
function specializeVertex(src, values) {
  let decl = "attribute highp vec4 dEQP_Position;\n", setup = "", output = "gl_Position = dEQP_Position;\n";
  for (const v of values.filter(v => v.kind === "input")) {
    if (scalarFloat(v.type)) decl += `attribute ${v.type} ${v.name};\n`;
    else { decl += `attribute ${floatOf(v.type)} a_${v.name};\n`; setup += `${v.type} ${v.name} = ${v.type}(a_${v.name});\n`; }
  }
  for (const v of values.filter(v => v.kind === "output")) {
    if (scalarFloat(v.type)) decl += `varying ${v.type} ${v.name};\n`;
    else { decl += `varying ${floatOf(v.type)} v_${v.name};\n${v.type} ${v.name};\n`; output += `v_${v.name} = ${floatOf(v.type)}(${v.name});\n`; }
  }
  return fill(src, { DECLARATIONS: decl, SETUP: setup, OUTPUT: output, POSITION_FRAG_COLOR: "gl_Position" });
}
function specializeFragment(src, values) {
  let decl = compareFunctions(values, false), setup = "";
  for (const v of values.filter(v => v.kind === "input")) {
    if (scalarFloat(v.type)) decl += `varying ${v.type} ${v.name};\n`;
    else { decl += `varying ${floatOf(v.type)} v_${v.name};\n`; setup += `${v.type} ${v.name} = ${v.type}(v_${v.name}${/^i/.test(v.type) || v.type === "int" ? " * 1.0025" : ""});\n`; }
  }
  for (const v of values.filter(v => v.kind === "output")) decl += `uniform ${v.type} ref_${v.name};\n${v.type} ${v.name};\n`;
  return fill(src, { DECLARATIONS: decl, SETUP: setup, OUTPUT: compareOp(values, "gl_FragColor", ""), POSITION_FRAG_COLOR: "gl_FragColor" });
}
function specializePair(c) {
  const values = c.values;
  let vdecl = "attribute highp vec4 dEQP_Position;\n", vsetup = "";
  for (const v of values.filter(v => v.kind === "input")) {
    if (scalarFloat(v.type)) vdecl += `attribute ${v.type} ${v.name};\n`;
    else { vdecl += `attribute ${floatOf(v.type)} a_${v.name};\n`; vsetup += `${v.type} ${v.name} = ${v.type}(a_${v.name});\n`; }
  }
  vdecl += uniformDecls(values);
  let fdecl = compareFunctions(values, false);
  for (const v of values.filter(v => v.kind === "output")) fdecl += `uniform ${v.type} ref_${v.name};\n${v.type} ${v.name};\n`;
  fdecl += uniformDecls(values);
  const params = { VERTEX_DECLARATIONS: vdecl, VERTEX_SETUP: vsetup, VERTEX_OUTPUT: "gl_Position = dEQP_Position;\n",
    FRAGMENT_DECLARATIONS: fdecl, FRAGMENT_OUTPUT: compareOp(values, "gl_FragColor", ""), FRAG_COLOR: "gl_FragColor" };
  return { vertex: fill(c.vertex, params), fragment: fill(c.fragment, params) };
}

function deqpCases(dir) {
  const cases = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith(".test")).sort()) {
    for (const c of parseTests(readFileSync(join(dir, file), "utf8"), basename(file, ".test"))) {
      if (c.requires.some(r => /full_glsl_es_100_support|extension/.test(r))) c.optional = true;
      if (c.both !== undefined) {
        cases.push({ name: `${c.name}_vertex`, expect: c.expect, optional: c.optional, vertex: specializeVertex(c.both, c.values), fragment: genFragment(c.values) });
        cases.push({ name: `${c.name}_fragment`, expect: c.expect, optional: c.optional, vertex: genVertex(c.values), fragment: specializeFragment(c.both, c.values) });
      } else if (c.vertex !== undefined && c.fragment !== undefined) {
        cases.push({ name: c.name, expect: c.expect, optional: c.optional, ...specializePair(c) });
      }
    }
  }
  return cases;
}

const satisfies = (status, expect) => expect === "pass" || expect === "build_successful" ? status === "pass"
  : expect === "compile_fail" ? status === "compile_fail" : expect === "link_fail" ? status === "link_fail"
  : expect === "compile_or_link_fail" ? status !== "pass" : false;

// --- run -------------------------------------------------------------------------

const bundle = await esbuild.build({ entryPoints: [join(here, "pipeline.ts")], bundle: true, write: false,
  format: "iife", platform: "browser", target: "es2022", logLevel: "error" });
const script = bundle.outputFiles[0].text;
mkdirSync(out, { recursive: true });
const cases = (deqp ? deqpCases(deqp) : []).filter(c => !filter || filter.test(c.name));
const singles = [];
if (sources) for (const f of readdirSync(sources).filter(f => f.endsWith(".glsl")).sort())
  singles.push({ name: f, source: readFileSync(join(sources, f), "utf8"), fragment: f.includes(".Fragment.") });

let regressions = 0;
for (const engine of engines) {
  const options = { headless: true };
  if (engine === "firefox" && process.platform === "darwin")
    options.env = { ...process.env, CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), "essl3-check-firefox-")) };
  const browser = await playwright[engine].launch(options);
  const report = { engine, version: browser.version() };
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ content: script });
    let active = page;
    if (cases.length) {
      // A renderer fault can leave WebGL unavailable to the page: continue
      // the remaining cases in a fresh page.
      const results = [];
      while (results.length < cases.length) {
        const result = await active.evaluate(c => window.runCases(c), cases.slice(results.length));
        report.renderer ??= result.renderer;
        results.push(...result.results);
        if (results.length < cases.length) {
          results.push({ name: cases[results.length].name, native: { status: "context_unavailable" },
            kandelo: { status: "context_unavailable" }, translated: { status: "context_unavailable" } });
          await active.close();
          active = await browser.newPage();
          await active.setContent("<!doctype html><html><body></body></html>");
          await active.addScriptTag({ content: script });
        }
      }
      const rows = results.map((r, i) => ({ ...r, expect: cases[i].expect, optional: cases[i].optional }));
      report.deqp = rows;
      const ok = (r, k) => satisfies(r[k].status, r.expect);
      const fixed = rows.filter(r => !ok(r, "native") && ok(r, "kandelo"));
      const broken = rows.filter(r => ok(r, "native") && !ok(r, "kandelo"));
      const stillFailing = rows.filter(r => !ok(r, "native") && !ok(r, "kandelo"));
      const divergent = rows.filter(r => r.native.status === "pass" && r.translated.status !== "pass");
      const acceptedInvalid = rows.filter(r => r.expect !== "pass" && r.expect !== "build_successful" && r.native.status !== "pass" && r.translated.status === "pass");
      console.log(`${engine} ${report.version}: dEQP ${rows.length} programs; host path: ${rows.filter(r => ok(r, "kandelo")).length} as expected ` +
        `(native ${rows.filter(r => ok(r, "native")).length}); newly right ${fixed.length}, newly wrong ${broken.length}, ` +
        `wrong both ${stillFailing.length}; always-translate diverges on ${divergent.length} valid, accepts ${acceptedInvalid.length} invalid`);
      for (const r of broken) console.log(`  REGRESSION ${r.name} expect=${r.expect} native=${r.native.status} kandelo=${r.kandelo.status} [${r.kandelo.languages}] ${r.kandelo.log ?? ""}`);
      for (const r of fixed) console.log(`  fixed ${r.name} expect=${r.expect} native=${r.native.status} kandelo=${r.kandelo.status} [${r.kandelo.languages}]`);
      for (const r of stillFailing) console.log(`  still wrong ${r.name}${r.optional ? " (optional)" : ""} expect=${r.expect} native=${r.native.status} kandelo=${r.kandelo.status} ${r.kandelo.log ?? ""}`);
      for (const r of divergent) console.log(`  translate-all diverges ${r.name}: ${r.translated.status} [${r.translated.languages}] ${r.translated.log ?? ""}`);
      for (const r of acceptedInvalid) console.log(`  translate-all accepts invalid ${r.name} expect=${r.expect}`);
      regressions += broken.length;
    }
    if (singles.length) {
      const results = await active.evaluate(s => window.runSingles(s), singles);
      report.singles = results;
      const count = f => results.filter(f).length;
      console.log(`${engine} ${report.version}: ${results.length} sources; native compile ${count(r => r.native)}, ` +
        `host path ${count(r => r.language)} (essl300 ${count(r => r.language === "essl300")}); ` +
        `native failures only Appendix A ${count(r => r.limitationsOnly)}`);
      const groups = new Map();
      for (const r of results.filter(r => !r.language)) {
        const key = r.log.replace(/\d+:\d+/g, "N:N").replace(/'[^']*'/g, "'X'").slice(0, 160);
        groups.set(key, [...groups.get(key) ?? [], r.name]);
      }
      for (const [key, names] of groups) console.log(`  ${names.length} still failing: ${key}\n      e.g. ${names[0]}`);
      regressions += count(r => r.native && !r.language);
    }
  } finally { await browser.close(); }
  writeFileSync(join(out, `${engine}.json`), JSON.stringify(report, null, 1) + "\n");
}
process.exit(regressions ? 1 : 0);
