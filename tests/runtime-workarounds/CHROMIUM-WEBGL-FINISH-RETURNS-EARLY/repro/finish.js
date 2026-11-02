// Standalone WebGL 2. No Kandelo imports, protocol, Wasm or guest memory.
//
// WebGL's finish() is OpenGL ES 2.0 section 5.1: it "does not return until
// all effects from previously issued commands ... are fully realized".
// WebGL 2.0 makes readPixels block until all previous rendering into the
// source framebuffer has finished, so the time a 1x1 readPixels takes right
// after finish() is the earlier work that finish() left outstanding.
function measureFinish(gl) {
  const now = () => performance.now();
  const size = 512;
  const vertex = `#version 300 es
  void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
  // A long per-fragment loop. Every draw writes the round's tag to blue, so
  // a read that does not return the tag shows that the work never ran.
  const fragment = `#version 300 es
  precision highp float; uniform int n; uniform float tag; uniform float alpha; out vec4 o;
  void main() { float a = gl_FragCoord.x * 0.001 + gl_FragCoord.y * 0.0007;
    for (int i = 0; i < n; i++) a = fract(sin(a * 12.9898 + float(i) * 0.37) * 43758.5453);
    o = vec4(a, 1.0 - a, tag / 255.0, alpha); }`;
  const shader = (type, source) => {
    const s = gl.createShader(type); gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const nLocation = gl.getUniformLocation(program, 'n'), tagLocation = gl.getUniformLocation(program, 'tag');
  // Blending with a run-time alpha of 1 keeps a tile-based GPU from
  // discarding the earlier, fully covered draws as hidden surfaces.
  gl.uniform1f(gl.getUniformLocation(program, 'alpha'), 1);
  gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(gl.createVertexArray());
  const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
  gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('framebuffer incomplete');
  gl.viewport(0, 0, size, size);

  const pixel = new Uint8Array(4);
  let tag = 0, draws = 1, missing = 0;
  const work = (n) => {
    tag = (tag % 250) + 1; gl.uniform1i(nLocation, n); gl.uniform1f(tagLocation, tag);
    for (let i = 0; i < draws; i++) gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
  const read = () => {
    const start = now(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    if (pixel[2] !== tag) missing++;
    return now() - start;
  };
  // Calibrate: one draw of at least 10 ms (far from any GPU watchdog), then
  // enough draws for about 300 ms. The read after the draws is the work.
  let n = 64;
  for (; n <= (1 << 20); n *= 2) { work(n); if (read() >= 10) break; }
  work(n); draws = Math.min(200, Math.ceil(300 / Math.max(read(), 0.5)));
  work(n); const workMs = read();

  const trials = [];
  for (let i = 0; i < 3; i++) {
    work(n);
    const start = now(); gl.finish(); const finishMs = now() - start;
    trials.push({ finishMs: +finishMs.toFixed(2), readAfterFinishMs: +read().toFixed(2) });
  }
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return { renderer: gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER), iterations: n, draws, workMs: +workMs.toFixed(1),
    missingWork: missing, error: gl.getError(), trials };
}

// reproduced: at least half of the work was still outstanding after every
// finish(). not-reproduced: finish() itself took the work and left at most a
// tenth. Anything else, or work too short to measure, is inconclusive.
function judge(result) {
  if (!result || result.failure || result.error || result.missingWork || result.workMs < 100) return 'inconclusive';
  const left = result.trials.map((t) => t.readAfterFinishMs / result.workMs);
  const took = result.trials.map((t) => t.finishMs / result.workMs);
  if (left.every((x) => x >= 0.5)) return 'reproduced';
  if (left.every((x) => x <= 0.1) && took.every((x) => x >= 0.5)) return 'not-reproduced';
  return 'inconclusive';
}
