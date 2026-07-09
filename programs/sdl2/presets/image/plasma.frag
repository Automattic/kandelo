// Default Shadertoy-style image shader: a plasma over the right pane.
// The host wraps this body with the GLSL ES 1.0 Shadertoy template
// from programs/sdl2/main.c (FRAG_PREFIX / FRAG_SUFFIX), so this file
// only contains the `mainImage(out vec4 fragColor, in vec2 fragCoord)`
// entry point that the wrapper calls.
//
// Kept in sync with the built-in PLASMA_SRC fallback in
// programs/sdl2/main.c — if you edit one, edit both. The duplication
// is so the binary still renders when no VFS shader is staged (e.g.
// host/test/sdl2.test.ts under NodeKernelHost).

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float r = 0.5 + 0.5 * sin(iTime + uv.x * 6.2831);
  float g = 0.5 + 0.5 * sin(iTime * 1.3 + uv.y * 6.2831);
  float b = 0.5 + 0.5 * sin(iTime * 0.7 + (uv.x + uv.y) * 6.2831);
  fragColor = vec4(r, g, b, 1.0);
}
