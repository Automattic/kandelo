# Firefox: GLSL ES 1.00 type hiding and texture LOD at triangle edges

Date: 2026-11-02. Playwright Firefox 155.0, Chromium 153.0.8010.12 and
WebKit 26.6 (the browser-demos Playwright builds), macOS on Apple silicon.
Firefox reports the renderer as "Apple M1, or similar".

The full dEQP-GLES2 runs of the graphics validation round left these
cases failing on Firefox only (they pass on Chromium and WebKit):

| Cases | Cause | Kandelo handling |
|---|---|---|
| `functional.state_query.rbo.renderbuffer_size` | Firefox reports 0x0 after renderbuffer storage with one zero dimension | workaround, [`FIREFOX-RENDERBUFFER-EMPTY-SIZE`](../../tests/runtime-workarounds/FIREFOX-RENDERBUFFER-EMPTY-SIZE/entry.md) |
| `functional.state_query.shader.program_validate_status` | Firefox validates programs with no linked executable as `true` | workaround, [`FIREFOX-VALIDATE-UNLINKED-PROGRAM`](../../tests/runtime-workarounds/FIREFOX-VALIDATE-UNLINKED-PROGRAM/entry.md) |
| `functional.shaders.scoping.valid.local_{int,struct}_variable_hides_struct_type_{vertex,fragment}` (4) | Firefox's shader compiler rejects a local variable that hides a struct type ([below](#a-variable-that-hides-a-struct-type)) | none; failure stays visible |
| `functional.texture.mipmap.2d.projected.*` (12) | Firefox selects the mipmap level of a lone fragment at a triangle edge from the neighbouring triangle ([below](#mipmap-level-at-a-triangle-edge)) | none; failure stays visible |
| `functional.texture.mipmap.cube.projected.nearest_{nearest,linear}` (2) | one pixel each, with the same signature as the 2D projected cases; not reduced separately | none |
| `functional.shaders.builtin_variable.max_vertex_uniform_vectors_{vertex,fragment}` | a Kandelo defect, fixed by commit 95c3791472 (built-in limit constants equal the queried limits); pass on Firefox at 581d234aa6 | fixed |

Both defects below come from standalone pages with no Kandelo code that
judge their own result; Chromium and WebKit are the controls. Neither has a
workaround: the first would need Kandelo to rewrite guest GLSL by scope
(a full GLSL front end), the second to split every draw into separate
triangles. Guest programs therefore see Firefox's behavior, and the dEQP
cases stay failing on Firefox. Whether each defect is in Firefox itself or
in the macOS OpenGL driver Firefox's WebGL runs on is not known; Linux and
Windows have not been checked. Not filed upstream.

## A variable that hides a struct type

GLSL ES 1.00 section 4.2 (Scoping): a variable's scope begins after its
declaration (after its initializer, when there is one), and a name declared
in an inner scope hides the same name in an outer scope, including a
structure type.
So inside a function, after `struct S { int val; };` at global scope,
`int S = S(u).val;` (the initializer still names the type) and
`S S = S(u); ... S.val` are valid.

Firefox's WebGL 2 compiler rejects both:
`ERROR: 0:10: ')' : syntax error` and `ERROR: 0:10: '.' : syntax error`.
Chromium and WebKit compile both. The control (a variable `s` of type `S`)
compiles everywhere. Results on 2026-11-02 with
`tests/runtime-workarounds/driver.mjs`:

| Target | Verdict |
|---|---|
| firefox 155.0 | reproduced |
| chromium 153.0.8010.12 | not-reproduced |
| webkit 26.6 | not-reproduced |

The two `local_variable_hides_function_parameter` cases, which fail with
`'x' : redefinition`, fail on all three engines and are not part of this
finding.

```html
<!doctype html><meta charset="utf-8"><pre id="result">Running</pre>
<script>
window.probe = function (body) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) throw Error('WebGL2 unavailable');
    const r = body(gl);
    r.details.renderer = gl.getParameter(gl.RENDERER);
    r.details.version = gl.getParameter(gl.VERSION);
    window.__reproVerdict = { verdict: r.verdict, details: JSON.stringify(r.details) };
  } catch (error) {
    window.__reproVerdict = { verdict: 'inconclusive', details: JSON.stringify({ error: String(error && error.stack || error) }) };
  }
  document.querySelector('#result').textContent = JSON.stringify(window.__reproVerdict, null, 2);
};
</script>
<script>
// GLSL ES 1.00 section 4.2 (Scoping): a variable's scope begins after its initializer, and a
// variable in an inner scope hides a struct type of the same name. These are
// dEQP-GLES2.functional.shaders.scoping.valid.local_*_variable_hides_struct_type.
probe(gl => {
  const head = '#version 100\nprecision mediump float;\nstruct S { int val; };\nuniform int u;\n';
  const sources = {
    control: head + 'void main() { S s = S(u); gl_FragColor = vec4(float(s.val)); }\n',
    intHides: head + 'void main() { int S = S(u).val; gl_FragColor = vec4(float(S)); }\n',
    structHides: head + 'void main() { S S = S(u); gl_FragColor = vec4(float(S.val)); }\n',
  };
  const res = {};
  for (const [k, s] of Object.entries(sources)) {
    const sh = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(sh, s); gl.compileShader(sh);
    res[k] = { compiled: gl.getShaderParameter(sh, gl.COMPILE_STATUS), log: gl.getShaderInfoLog(sh) };
  }
  return { verdict: !res.control.compiled ? 'inconclusive'
           : (res.intHides.compiled && res.structHides.compiled) ? 'not-reproduced' : 'reproduced', details: res };
});
</script>
```

## Mipmap level at a triangle edge

dEQP's projected mipmap cases draw a 4x4 grid of quads, each two triangles
(indices 0,1,2 and 2,1,3) whose vertices have different clip-space `w`, so
the texture coordinate is perspective-interpolated and its screen-space
derivatives differ between the two triangles. Each mipmap level of the
64x64 texture is one solid color, so every pixel shows the level the
implementation chose. dEQP accepts a level if it lies within the LOD bounds
of the pixel's own triangle, evaluated at the pixel and one pixel to each
side, with 10 accurate derivative bits and 6 LOD bits.

On Firefox, pixels just above a quad's diagonal fail: each is the
upper-right pixel of a 2x2 pixel quad whose other three pixels lie on or
below the diagonal, and it gets the level of those neighbours, one level
below what its own triangle allows. The page below repeats dEQP's geometry
in plain WebGL 2 and applies the same tolerance. It finds the same 13 pixels
dEQP reported for `mipmap.2d.projected.nearest_nearest_clamp` in Kandelo
(starting (183,9), (181,11), (217,103) in cell 2 and 7). Drawing each
triangle alone gives every one of those pixels a level its triangle allows,
so the wrong level comes from the neighbouring triangle in the same draw.
OpenGL ES 2.0 section 3.7.7 selects the level from the derivatives of the
fragment's own texture coordinates, which belong to its own primitive; a
level outside that primitive's bounds is what the conformance test rejects. A `highp` texture coordinate fails the same way, so it is not
a `mediump` precision effect. The cube-map case's single failing pixel has
the same signature (odd x and y, the left and lower neighbours' color).

| Target | Two-triangle draw | One triangle per draw | Verdict |
|---|---|---|---|
| firefox 155.0 | 13 pixels outside the bounds (`mediump` and `highp`) | 0 | reproduced |
| chromium 153.0.8010.12 | 0 | 0 | not-reproduced |
| webkit 26.6 | 0 | 0 | not-reproduced |

The page reports `inconclusive` if any one-triangle draw fails, which would
mean its own tolerance is wrong.

```html
<!doctype html><meta charset="utf-8"><pre id="result">Running</pre>
<script>
window.probe = function (body) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 4;
    const gl = canvas.getContext('webgl2', { antialias: false });
    if (!gl) throw Error('WebGL2 unavailable');
    const r = body(gl);
    r.details.renderer = gl.getParameter(gl.RENDERER);
    r.details.version = gl.getParameter(gl.VERSION);
    window.__reproVerdict = { verdict: r.verdict, details: JSON.stringify(r.details) };
  } catch (error) {
    window.__reproVerdict = { verdict: 'inconclusive', details: JSON.stringify({ error: String(error && error.stack || error) }) };
  }
  document.querySelector('#result').textContent = JSON.stringify(window.__reproVerdict, null, 2);
};
</script>
<script>
// Standalone WebGL 2 (GLSL ES 1.00 shaders). No Kandelo code.
// Reproduces the geometry of dEQP-GLES2.functional.texture.mipmap.2d.projected.*:
// a 256x256 target split into a 4x4 grid of 64x64 cells; each cell is one quad
// (two triangles, indices 0,1,2 / 2,1,3) whose vertices have different clip w,
// so the texture coordinate is perspective-interpolated. The 64x64 texture has a
// distinct solid colour per mip level and NEAREST_MIPMAP_NEAREST filtering, so
// every pixel tells which level the implementation selected.
//
// Judgement (ES 2.0 section 3.7.7, using dEQP's own LOD tolerance: derivative
// bounds from the pixel's triangle at the pixel and at +-1 pixel offsets,
// 10 accurate derivative bits, 6 LOD bits): a level outside the allowed range is
// an error. The same cells are also drawn one triangle at a time (control); a
// fragment's level must not depend on whether the neighbouring triangle is drawn.
// reproduced     = errors in the two-triangle draw, none in the one-triangle draws
// not-reproduced = no errors in either
// inconclusive   = errors in the one-triangle draws (the judgement itself is off)
const SIZE = 64, GRID = 4, CELL = SIZE, TARGET = CELL * GRID, LEVELS = 7;
const basic = [[[-0.1,0.1],[0.8,1.0]],[[-0.3,-0.6],[0.7,0.4]],[[-0.3,0.6],[0.7,-0.9]],[[-0.8,0.6],[0.7,-0.9]],
  [[-0.5,-0.5],[1.5,1.5]],[[1.0,-1.0],[-1.3,1.0]],[[1.2,-1.0],[-1.3,1.6]],[[2.2,-1.1],[-1.3,0.8]],
  [[-1.5,1.6],[1.7,-1.4]],[[2.0,1.6],[2.3,-1.4]],[[1.3,-2.6],[-2.7,2.9]],[[-0.8,-6.6],[6.0,-0.9]],
  [[-8.0,9.0],[8.3,-7.0]],[[-16.0,10.0],[18.3,24.0]],[[30.2,55.0],[-24.3,-1.6]],[[-33.2,64.1],[32.1,-64.1]]];
const proj = [[1.2,1.0,0.7,1.0],[1.3,0.8,0.6,2.0],[0.8,1.0,1.7,0.6],[1.2,1.0,1.7,1.5]];
const colour = l => [l * 40, 255 - l * 40, (l * 97) & 255, 255];

function triDx(s, w, wx, width, ny) {
  const d = w[1]*w[2]*(width*(ny-1)+wx) - w[0]*(w[2]*width*ny + w[1]*wx);
  return (w[0]*w[1]*w[2]*width*(w[1]*(s[0]-s[2])*(ny-1) + ny*(w[2]*(s[1]-s[0]) + w[0]*(s[2]-s[1])))) / (d*d);
}
function triDy(s, w, wy, height, nx) {
  const d = w[1]*w[2]*(height*(nx-1)+wy) - w[0]*(w[1]*height*nx + w[2]*wy);
  return (w[0]*w[1]*w[2]*height*(w[2]*(s[0]-s[1])*(nx-1) + nx*(w[0]*(s[1]-s[2]) + w[1]*(s[2]-s[0])))) / (d*d);
}
const fpErr = (v, bits) => Math.pow(2, Math.floor(Math.log2(v))) * ((1 << (23 - bits)) - 1) / (1 << 23);
function lodBounds(dudx, dvdx, dudy, dvdy) {
  const pMin = Math.max(Math.abs(dudx), Math.abs(dvdx), Math.abs(dudy), Math.abs(dvdy));
  const pMax = Math.SQRT2 * Math.max(Math.abs(dudx) + Math.abs(dvdx), Math.abs(dudy) + Math.abs(dvdy));
  const lodErr = 1 / 64;
  return [Math.log2(pMin - fpErr(pMin, 10)) - lodErr, Math.log2(pMax + fpErr(pMax, 10)) + lodErr];
}
const nearestLevel = lod => lod <= 0.5 ? 0 : Math.min(LEVELS - 1, Math.max(0, Math.ceil(lod + 0.5) - 1));
function allowedLevels(cell, px, py) {
  const [bl, tr] = basic[cell], w4 = proj[cell % 4];
  const sq = [bl[0], bl[0], tr[0], tr[0]], tq = [bl[1], tr[1], bl[1], tr[1]];
  const triS = [[sq[0], sq[1], sq[2]], [sq[3], sq[2], sq[1]]], triT = [[tq[0], tq[1], tq[2]], [tq[3], tq[2], tq[1]]];
  const triW = [[w4[0], w4[1], w4[2]], [w4[3], w4[2], w4[1]]];
  const wx = px + 0.5, wy = py + 0.5, nx = wx / CELL, ny = wy / CELL, eps = 1 / 256;
  const tris = [];
  if ((wx - eps) / CELL + (wy - eps) / CELL <= 1) tris.push(0);
  if ((wx + eps) / CELL + (wy + eps) / CELL >= 1) tris.push(1);
  const ok = new Set();
  for (const t of tris) {
    const tWx = t ? CELL - wx : wx, tWy = t ? CELL - wy : wy, tNx = t ? 1 - nx : nx, tNy = t ? 1 - ny : ny;
    const at = (x, y, nX, nY) => lodBounds(triDx(triS[t], triW[t], x, CELL, nY) * SIZE, triDx(triT[t], triW[t], x, CELL, nY) * SIZE,
      triDy(triS[t], triW[t], y, CELL, nX) * SIZE, triDy(triT[t], triW[t], y, CELL, nX) * SIZE);
    let [lo, hi] = at(wx, wy, tNx, tNy);
    for (const [ox, oy] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const x = tWx + ox, y = tWy + oy, b = at(x, y, x / CELL, y / CELL);
      lo = Math.min(lo, b[0]); hi = Math.max(hi, b[1]);
    }
    for (let l = nearestLevel(lo); l <= nearestLevel(hi); l++) ok.add(l);
  }
  return { ok, tris };
}

probe(gl => {
  const results = {};
  for (const precision of ['mediump', 'highp']) {
    const vs = `attribute highp vec4 a_position;\nattribute highp vec2 a_texCoord;\nvarying ${precision} vec2 v_texCoord;\n` +
      'void main() { gl_Position = a_position; v_texCoord = a_texCoord; }\n';
    const fs = `uniform lowp sampler2D u_sampler;\nvarying ${precision} vec2 v_texCoord;\n` +
      'void main() { gl_FragColor = texture2D(u_sampler, v_texCoord); }\n';
    const program = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(sh));
      gl.attachShader(program, sh);
    }
    gl.bindAttribLocation(program, 0, 'a_position'); gl.bindAttribLocation(program, 1, 'a_texCoord');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);

    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    for (let l = 0; l < LEVELS; l++) {
      const n = SIZE >> l, data = new Uint8Array(n * n * 4);
      for (let i = 0; i < n * n; i++) data.set(colour(l), i * 4);
      gl.texImage2D(gl.TEXTURE_2D, l, gl.RGBA, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const rt = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, rt);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TARGET, TARGET, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error('fbo incomplete');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const pos = gl.createBuffer(), tc = gl.createBuffer(), idx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 2, 1, 3]), gl.STATIC_DRAW);

    function render(mode) { // mode: 'both' | 0 | 1 (triangle index)
      gl.viewport(0, 0, TARGET, TARGET); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      for (let cell = 0; cell < 16; cell++) {
        const [bl, tr] = basic[cell], w = proj[cell % 4];
        const p = [-1, -1, -1, 1, 1, -1, 1, 1];
        const position = new Float32Array(16);
        for (let v = 0; v < 4; v++) position.set([p[v*2] * w[v], p[v*2+1] * w[v], 0, w[v]], v * 4);
        gl.bindBuffer(gl.ARRAY_BUFFER, pos); gl.bufferData(gl.ARRAY_BUFFER, position, gl.STREAM_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, tc);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([bl[0], bl[1], bl[0], tr[1], tr[0], bl[1], tr[0], tr[1]]), gl.STREAM_DRAW);
        gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
        gl.viewport((cell % GRID) * CELL, Math.floor(cell / GRID) * CELL, CELL, CELL);
        if (mode === 'both') gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
        else gl.drawElements(gl.TRIANGLES, 3, gl.UNSIGNED_SHORT, mode * 6);
      }
      const px = new Uint8Array(TARGET * TARGET * 4);
      gl.readPixels(0, 0, TARGET, TARGET, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    }
    const levelOf = (px, i) => {
      for (let l = 0; l < LEVELS; l++) { const c = colour(l); if (Math.abs(px[i] - c[0]) <= 2 && Math.abs(px[i+1] - c[1]) <= 2 && Math.abs(px[i+2] - c[2]) <= 2) return l; }
      return -1;
    };
    function verify(px, only) {
      const bad = [];
      for (let y = 0; y < TARGET; y++) for (let x = 0; x < TARGET; x++) {
        const cell = Math.floor(y / CELL) * GRID + Math.floor(x / CELL), lx = x % CELL, ly = y % CELL;
        const i = (y * TARGET + x) * 4;
        if (px[i + 3] === 0) continue; // not covered (one-triangle draws)
        const { ok, tris } = allowedLevels(cell, lx, ly);
        if (only !== undefined && !tris.includes(only)) continue;
        const l = levelOf(px, i);
        if (!ok.has(l)) bad.push({ x, y, cell, level: l, allowed: [...ok], quadLone: (lx & 1) === 1 && (ly & 1) === 1 });
      }
      return bad;
    }
    const both = render('both'); const t0 = render(0), t1 = render(1);
    const badBoth = verify(both), badSplit = [...verify(t0, 0), ...verify(t1, 1)];
    // Same fragment, with and without the neighbouring triangle drawn.
    let differs = 0;
    for (const b of badBoth) { const i = (b.y * TARGET + b.x) * 4; const s = t0[i+3] ? t0 : t1; if (levelOf(s, i) !== b.level) differs++; }
    results[precision] = { badBoth: badBoth.length, badSplit: badSplit.length, badBothDifferFromSplit: differs,
      firstBad: badBoth.slice(0, 6), firstBadSplit: badSplit.slice(0, 3) };
    gl.deleteProgram(program);
  }
  const m = results.mediump;
  const verdict = m.badSplit > 0 ? 'inconclusive' : m.badBoth > 0 ? 'reproduced' : 'not-reproduced';
  return { verdict, details: results };
});
</script>
```
