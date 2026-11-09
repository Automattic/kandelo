#!/usr/bin/env node
// Cost of sampling ES 2.0 cube maps per face (host/src/webgl/cube-storage.ts,
// essl3-translation.ts) against WebGL 2's native (seamless) cube map, in
// each engine. Only programs that sample a cube map pay any of it.
// Usage: node tests/graphics/shader-rewrite-check/cube-bench.mjs [engine...]
//  - compile: CompileShader of a skybox/reflection fragment shader, native
//    ES 1.00 vs the host path (ES 1.00 validity compile, translation, ESSL
//    3.00 compile), mean of 40.
//  - draw: a 1024x1024 quad whose fragments make 1, 4 or 16 lookups at
//    varying directions (trilinear, 256x256 faces), median of 5 batches
//    of 300 additively blended draws, each batch ended by a 1-pixel readPixels, native samplerCube on a cube
//    map vs the translation on the six-layer 2D array. Firefox and WebKit
//    coarsen performance.now() to 1 ms, so draws are timed in batches.
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
  import { compileGuestShader, prepareLinkLanguages, recordShaderLanguage, translateEssl100 } from "./host/src/webgl/essl3-translation.ts";
  const VERTEX = "attribute vec2 p;\\nvarying vec3 d;\\nvoid main() { d = vec3(1.0, p * 1.8); gl_Position = vec4(p, 0.0, 1.0); }\\n";
  const fragment = (lookups) => "precision mediump float;\\nuniform samplerCube env;\\nvarying vec3 d;\\nvoid main() {\\nvec4 c = vec4(0.0);\\n" +
    Array.from({ length: lookups }, (_, i) => "c += textureCube(env, d + vec3(0.0, " + (i * 0.05).toFixed(2) + ", " + (-i * 0.03).toFixed(2) + "));\\n").join("") +
    "gl_FragColor = c / " + lookups + ".0;\\n}\\n";
  window.bench = () => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
    const gl = canvas.getContext("webgl2", { antialias: false });
    const out = { renderer: (() => { const x = gl.getExtension("WEBGL_debug_renderer_info"); return x ? gl.getParameter(x.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })(), compile: {}, draw: {} };
    // Compile cost.
    const source = fragment(4), repeat = 40;
    const timeCompile = (work) => { const shaders = Array.from({ length: repeat }, () => gl.createShader(gl.FRAGMENT_SHADER));
      const t = performance.now(); for (const s of shaders) work(s); const ms = (performance.now() - t) / repeat;
      for (const s of shaders) gl.deleteShader(s); return ms; };
    out.compile.native100 = timeCompile(s => { gl.shaderSource(s, source); gl.compileShader(s); gl.getShaderParameter(s, gl.COMPILE_STATUS); });
    out.compile.hostPath = timeCompile(s => compileGuestShader(gl, s, source, true));
    const t0 = performance.now(); for (let i = 0; i < repeat; i++) translateEssl100(source, true); out.compile.translation = (performance.now() - t0) / repeat;
    // Textures: a 256x256 trilinear cube map and the same images as a six-layer array.
    const size = 256, levels = 9;
    const make = (array) => { const tex = gl.createTexture(), target = array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_CUBE_MAP;
      gl.bindTexture(target, tex);
      for (let level = 0, n = size; level < levels; level++, n >>= 1) {
        const px = new Uint8Array(n * n * 4); for (let i = 0; i < px.length; i++) px[i] = (i * 37 + level * 11) & 255;
        if (array) { gl.texImage3D(target, level, gl.RGBA8, n, n, 6, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          for (let f = 0; f < 6; f++) gl.texSubImage3D(target, level, 0, 0, f, n, n, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); }
        else for (let f = 0; f < 6; f++) gl.texImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, level, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return { tex, target }; };
    const cube = make(false), array = make(true);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const link = (vs, fs, host) => {
      const shaders = [[gl.VERTEX_SHADER, vs, false], [gl.FRAGMENT_SHADER, fs, true]].map(([type, src, frag]) => {
        const s = gl.createShader(type);
        if (host) recordShaderLanguage(s, compileGuestShader(gl, s, src, frag), src, frag); else { gl.shaderSource(s, src); gl.compileShader(s); }
        return s; });
      const p = gl.createProgram(); for (const s of shaders) gl.attachShader(p, s);
      if (host) prepareLinkLanguages(gl, shaders);
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p; };
    const pixel = new Uint8Array(4);
    const timeDraws = (program, texture) => {
      gl.useProgram(program); gl.bindTexture(texture.target, texture.tex);
      const at = gl.getAttribLocation(program, "p"); gl.enableVertexAttribArray(at); gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
      gl.viewport(0, 0, 1024, 1024);
      // Additive blending: a tile-based GPU (Apple) would otherwise shade
      // only the last of a batch of opaque full-screen draws.
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      const draw = (n) => { for (let i = 0; i < n; i++) gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel); };
      draw(3);
      const runs = []; for (let r = 0; r < 5; r++) { const t = performance.now(); draw(300); runs.push((performance.now() - t) / 300); }
      return runs.sort((x, y) => x - y)[2]; };
    for (const lookups of [1, 4, 16]) {
      const fs = fragment(lookups);
      const native = link(VERTEX, fs, false), host = link(VERTEX, fs, true);
      const a = timeDraws(native, cube), b = timeDraws(host, array), c = timeDraws(native, cube), d = timeDraws(host, array);
      out.draw[lookups] = { native: Math.min(a, c), perFace: Math.min(b, d) };
    }
    return out;
  };`, resolveDir: root, loader: "ts" }, bundle: true, write: false, format: "iife", platform: "browser", logLevel: "error" });

for (const engine of engines) {
  const options = { headless: true };
  if (engine === "firefox" && process.platform === "darwin") options.env = { ...process.env, CFFIXED_USER_HOME: mkdtempSync(join(tmpdir(), "cube-bench-ff-")) };
  const browser = await playwright[engine].launch(options);
  const p = await browser.newPage();
  await p.setContent("<!doctype html><body></body>");
  await p.addScriptTag({ content: page.outputFiles[0].text });
  const r = await p.evaluate(() => window.bench());
  console.log(`${engine} ${browser.version()} (${r.renderer})`);
  console.log(`  compile (4-lookup fragment shader, mean of 40): native ES 1.00 ${r.compile.native100.toFixed(2)} ms, ` +
    `host path ${r.compile.hostPath.toFixed(2)} ms (translation ${r.compile.translation.toFixed(3)} ms)`);
  for (const [lookups, d] of Object.entries(r.draw))
    console.log(`  draw 1024x1024, ${lookups} lookup(s)/fragment: native ${d.native.toFixed(3)} ms, per-face ${d.perFace.toFixed(3)} ms (${(d.perFace / d.native).toFixed(2)}x)`);
  await browser.close();
}
