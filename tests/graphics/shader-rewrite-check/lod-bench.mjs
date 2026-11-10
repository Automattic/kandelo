#!/usr/bin/env node
// Cost of ES 2.0's switch-over point c = 0.5 (host/src/webgl/lod-switchover.ts,
// essl3-translation.ts lodSwitchHelpers) in each engine. Only draws whose
// program samples a texture with MAG_FILTER LINEAR and MIN_FILTER
// NEAREST_MIPMAP_NEAREST/NEAREST_MIPMAP_LINEAR pay any of it.
// Usage: node tests/graphics/shader-rewrite-check/lod-bench.mjs [engine...]
//  - build: the variant's translation, two ESSL 3.00 compiles and a link
//    (once per program and sampler set), against compiling and linking the
//    ES 1.00 program, mean of 20.
//  - draw: a 1024x1024 quad whose fragments make 1, 4 or 16 lookups of a
//    256x256 mipmapped texture (NEAREST_MIPMAP_LINEAR, LINEAR) at varying
//    coordinates, median of 5 batches of additively blended draws (about
//    one second each, 10 to 5000 draws), each batch ended by a 1-pixel
//    readPixels. 2D: the ES 1.00 program vs its
//    switch-over variant; cube: the per-face translation (cube-storage.ts)
//    vs its switch-over variant. Firefox and WebKit coarsen
//    performance.now() to 1 ms, so draws are timed in batches.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const require = createRequire(join(root, "host/package.json"));
const esbuild = require("esbuild"), playwright = require("playwright");
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ["chromium", "firefox", "webkit"];

const page = await esbuild.build({ stdin: { contents: `
  import { translateEssl100 } from "./host/src/webgl/essl3-translation.ts";
  const VERTEX = "attribute vec2 p;\\nvarying vec2 uv;\\nvoid main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }\\n";
  const fragment = (cube, lookups) => "precision mediump float;\\nuniform " + (cube ? "samplerCube" : "sampler2D") + " tex;\\nvarying vec2 uv;\\nvoid main() {\\nvec4 c = vec4(0.0);\\n" +
    Array.from({ length: lookups }, (_, i) => { const o = "uv * " + (0.3 + i * 0.04).toFixed(2) + " + vec2(" + (i * 0.01).toFixed(2) + ")";
      return "c += " + (cube ? "textureCube(tex, vec3(1.0, 2.0 * (" + o + ") - 1.0))" : "texture2D(tex, " + o + ")") + ";\\n"; }).join("") +
    "gl_FragColor = c / " + lookups + ".0;\\n}\\n";
  window.bench = () => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
    const gl = canvas.getContext("webgl2", { antialias: false });
    const out = { renderer: (() => { const x = gl.getExtension("WEBGL_debug_renderer_info"); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })(), build: {}, draw: {} };
    const link = (vs, fs) => {
      const shaders = [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]].map(([type, src]) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; });
      const p = gl.createProgram(); for (const s of shaders) gl.attachShader(p, s);
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) + shaders.map(s => gl.getShaderInfoLog(s)).join(" "));
      for (const s of shaders) gl.deleteShader(s);
      return p; };
    const set = new Set(["tex"]);
    const variant = (cube, fs) => link(translateEssl100(VERTEX, false, set).text, translateEssl100(fs, true, set).text);
    const plain = (cube, fs) => cube ? link(translateEssl100(VERTEX, false).text, translateEssl100(fs, true).text) : link(VERTEX, fs);
    // Build cost (4 lookups, 2D).
    const fs4 = fragment(false, 4), repeat = 20;
    const timeBuild = (make) => { const programs = []; const t = performance.now(); for (let i = 0; i < repeat; i++) programs.push(make()); const ms = (performance.now() - t) / repeat; for (const p of programs) gl.deleteProgram(p); return ms; };
    out.build.es100 = timeBuild(() => link(VERTEX, fs4));
    out.build.variant = timeBuild(() => variant(false, fs4));
    const t0 = performance.now(); for (let i = 0; i < repeat; i++) { translateEssl100(VERTEX, false, set); translateEssl100(fs4, true, set); } out.build.translation = (performance.now() - t0) / repeat;
    // Textures: 256x256, 9 levels, NEAREST_MIPMAP_LINEAR + LINEAR (ES 2.0's initial filters).
    const size = 256, levels = 9;
    const make = (array) => { const tex = gl.createTexture(), target = array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D;
      gl.bindTexture(target, tex);
      for (let level = 0, n = size; level < levels; level++, n >>= 1) {
        const px = new Uint8Array(n * n * 4); for (let i = 0; i < px.length; i++) px[i] = (i * 37 + level * 11) & 255;
        if (array) { gl.texImage3D(target, level, gl.RGBA8, n, n, 6, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          for (let f = 0; f < 6; f++) gl.texSubImage3D(target, level, 0, 0, f, n, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
        else gl.texImage2D(target, level, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return { tex, target }; };
    const textures = { false: make(false), true: make(true) };
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pixel = new Uint8Array(4);
    const timeDraws = (program, texture) => {
      gl.useProgram(program); gl.bindTexture(texture.target, texture.tex);
      const at = gl.getAttribLocation(program, "p"); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 1024, 1024);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      const draw = (n) => { for (let i = 0; i < n; i++) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); };
      draw(3);
      // Batches of about one second (10 to 5000 draws), so a software
      // renderer's GPU watchdog never sees one long readPixels.
      const t0 = performance.now(); draw(10); const n = Math.max(10, Math.min(5000, Math.round(10000 / Math.max(1, performance.now() - t0))));
      const runs = []; for (let r = 0; r < 5; r++) { const t = performance.now(); draw(n); runs.push((performance.now() - t) / n); }
      return runs.sort((x, y) => x - y)[2]; };
    for (const cube of [false, true]) for (const lookups of [1, 4, 16]) {
      const fs = fragment(cube, lookups), base = plain(cube, fs), lod = variant(cube, fs), texture = textures[cube];
      const a = timeDraws(base, texture), b = timeDraws(lod, texture), c = timeDraws(base, texture), d = timeDraws(lod, texture);
      out.draw[(cube ? "cube " : "2d ") + lookups] = { base: Math.min(a, c), lod: Math.min(b, d) };
      gl.deleteProgram(base); gl.deleteProgram(lod);
    }
    return out;
  };`, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser", logLevel: "error" });

for (const engine of engines) {
  const options = { headless: true };
  if (engine === "firefox" && process.platform === "darwin") options.env = { ...process.env, CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), "lod-bench-ff-")) };
  const browser = await playwright[engine].launch(options);
  const p = await browser.newPage();
  await p.setContent("<!doctype html><body></body>");
  await p.addScriptTag({ content: page.outputFiles[0].text });
  const r = await p.evaluate(() => window.bench());
  console.log(`${engine} ${browser.version()} (${r.renderer})`);
  console.log(`  build (4-lookup 2D program, mean of 20): ES 1.00 compile+link ${r.build.es100.toFixed(2)} ms, ` +
    `switch-over variant ${r.build.variant.toFixed(2)} ms (translation ${r.build.translation.toFixed(3)} ms)`);
  for (const [key, d] of Object.entries(r.draw))
    console.log(`  draw 1024x1024, ${key} lookup(s)/fragment: without ${d.base.toFixed(3)} ms, switch-over ${d.lod.toFixed(3)} ms (${(d.lod / d.base).toFixed(2)}x)`);
  await browser.close();
}
