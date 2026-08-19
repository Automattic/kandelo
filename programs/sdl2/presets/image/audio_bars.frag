// Phase 5 preset: a 128-bar FFT visualizer driven by the chip synth.
// The host wraps this body with the GLSL ES 1.0 Shadertoy template from
// programs/sdl2/renderer.c, which declares the uniforms used below
// (iResolution, iTime, iAudio). iAudio is a 128x1 GL_LUMINANCE texture
// holding the live magnitude spectrum (see programs/sdl2/audio.c):
// texture2D(iAudio, vec2(x, 0.0)).r is the level at normalized
// frequency x in [0, 1].
//
// Load this in the playground (or let it boot as the right-pane preset)
// and the bars must visibly react to the synth — bass on the left,
// highs on the right. A flat bar row means the audio ring is silent
// (e.g. muted via Ctrl+M, or a headless GL context with no audio pull).

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;

  // Sample the spectrum at this column. A small smoothing offset reads
  // two neighboring frequencies so the LINEAR-filtered texture gives
  // continuous bar heights rather than 128 hard steps.
  float level = texture2D(iAudio, vec2(uv.x, 0.0)).r;

  // Bar: lit below the level line, dark above. A bright cap near the
  // top of each bar reads as a peak meter.
  float bar = step(uv.y, level);
  float cap = smoothstep(level - 0.02, level, uv.y)
            * step(uv.y, level + 0.02);

  // Hue sweeps blue->magenta across the spectrum; brightness rises with
  // the bar level so loud bands glow.
  vec3 lowCol  = vec3(0.10, 0.45, 1.00);
  vec3 highCol = vec3(1.00, 0.25, 0.65);
  vec3 barCol  = mix(lowCol, highCol, uv.x) * (0.35 + 0.65 * level);

  vec3 bg = vec3(0.03, 0.03, 0.06);
  vec3 col = mix(bg, barCol, bar);
  col += cap * vec3(1.0);  // white peak cap

  fragColor = vec4(col, 1.0);
}
