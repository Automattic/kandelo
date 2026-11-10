// Browser half of run.mjs: compiles and links each case three ways with the
// engine's real WebGL 2 compiler.
//   native:     the sources as ESSL 1.00, as Kandelo compiled them before
//               the ESSL 3.00 translation existed.
//   kandelo:    the host's path (shader-source.ts, program-objects.ts): the
//               derivatives rewrite, compileGuestShader, and promotion of a
//               1.00 link partner of a translated shader.
//   translated: every shader that compiles as 1.00 (or fails only for
//               Appendix A) translated, to exercise the translator on every
//               valid shader, not only on those that need it.
import { compileEssl300, compileGuestShader, standardDerivativesShaderSource, onlyAppendixALimitations,
  type ShaderLanguage } from "../../../host/src/webgl/essl3-translation.js";

type Case = { name: string; vertex: string; fragment: string };
type Outcome = { status: "pass" | "compile_fail" | "link_fail"; languages?: string; log?: string };

function run(gl: WebGL2RenderingContext, c: Case, mode: "native" | "kandelo" | "translated"): Outcome {
  const shaders: WebGLShader[] = [], languages: (ShaderLanguage | null)[] = [];
  const sources = [c.vertex, c.fragment].map(s => mode === "native" ? s : standardDerivativesShaderSource(s));
  let log = "";
  try {
    for (const [i, source] of sources.entries()) {
      const shader = gl.createShader(i ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER)!;
      shaders.push(shader);
      let language: ShaderLanguage | null;
      if (mode === "native") {
        gl.shaderSource(shader, source); gl.compileShader(shader);
        language = gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? "essl100" : null;
      } else {
        language = compileGuestShader(gl, shader, source, i === 1);
        if (mode === "translated" && language === "essl100") language = compileEssl300(gl, shader, source, i === 1) ? "essl300" : null;
      }
      languages.push(language);
      if (!language) log += (gl.getShaderInfoLog(shader) ?? "").trim().split("\n").slice(0, 2).join(" / ");
    }
    if (languages.includes(null)) return { status: "compile_fail", languages: languages.join(","), log };
    // Promotion: ES forbids linking different language versions.
    if (languages.includes("essl300")) for (const [i, language] of languages.entries())
      if (language === "essl100") languages[i] = compileEssl300(gl, shaders[i], sources[i], i === 1) ? "essl300" : null;
    if (languages.includes(null)) return { status: "compile_fail", languages: languages.join(","), log: "promotion failed" };
    const program = gl.createProgram()!;
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.bindAttribLocation(program, 0, "dEQP_Position");
    gl.linkProgram(program);
    const linked = !!gl.getProgramParameter(program, gl.LINK_STATUS);
    const programLog = (gl.getProgramInfoLog(program) ?? "").trim().split("\n")[0];
    gl.deleteProgram(program);
    return { status: linked ? "pass" : "link_fail", languages: languages.join(","), log: linked ? undefined : programLog };
  } finally { for (const shader of shaders) gl.deleteShader(shader); }
}

/** One shader alone: native compile status and log, the decision the host
 * makes, and the translated compile. */
function single(gl: WebGL2RenderingContext, source: string, fragment: boolean) {
  const shader = gl.createShader(fragment ? gl.FRAGMENT_SHADER : gl.VERTEX_SHADER)!;
  gl.shaderSource(shader, source); gl.compileShader(shader);
  const native = !!gl.getShaderParameter(shader, gl.COMPILE_STATUS), nativeLog = gl.getShaderInfoLog(shader) ?? "";
  const language = compileGuestShader(gl, shader, standardDerivativesShaderSource(source), fragment);
  const log = (gl.getShaderInfoLog(shader) ?? "").trim().split("\n").slice(0, 2).join(" / ");
  gl.deleteShader(shader);
  return { native, limitationsOnly: !native && onlyAppendixALimitations(nativeLog), language, log };
}

declare global { interface Window { runCases(cases: Case[]): Promise<unknown>; runSingles(s: { name: string; source: string; fragment: boolean }[]): unknown } }
// A case that loses the context (a renderer fault) is recorded and the next
// case gets a fresh context, so one fault cannot fail every later case. The
// loss is observable only after yielding to the event loop.
const context = () => document.createElement("canvas").getContext("webgl2")!;
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
window.runCases = async (cases: Case[]) => {
  let gl = context();
  const renderer = gl.getParameter(gl.RENDERER);
  const results = [];
  for (const c of cases) {
    if (!gl) break;
    const row: Record<string, unknown> = { name: c.name };
    for (const mode of ["native", "kandelo", "translated"] as const) {
      row[mode] = run(gl, c, mode);
      await tick();
      if (gl.isContextLost()) { row[mode] = { status: "context_lost" }; gl = context(); if (!gl) break; }
    }
    results.push(row);
  }
  return { renderer, results };
};
window.runSingles = (shaders) => {
  const gl = document.createElement("canvas").getContext("webgl2")!;
  return shaders.map(s => ({ name: s.name, ...single(gl, s.source, s.fragment) }));
};
