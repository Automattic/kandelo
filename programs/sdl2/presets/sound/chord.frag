// Phase 6 sound preset: a major-triad arpeggio.
// Steps through the notes of a C-major chord (C–E–G–C) four times a
// second, each note a plucked sine with a short decay envelope. Shows
// distinct FFT peaks marching up the spectrum in the iAudio visualizer.
// See programs/sdl2/sound_shader.c for the mainSound contract.
//
// Note: GLSL ES 1.00 fragment shaders don't allow dynamically-indexed
// local arrays, so the ratio is picked with an if-chain rather than
// array lookup.

float ratio_for(float step) {
  // Equal-temperament ratios for C, E, G, and the octave C.
  if (step < 0.5) return 1.0;       // C
  if (step < 1.5) return 1.2599;    // major third (E)
  if (step < 2.5) return 1.4983;    // perfect fifth (G)
  return 2.0;                       // octave C
}

vec2 mainSound(in float time) {
  float base = 261.63;                            // C4
  float step = floor(fract(time * 0.25) * 4.0);   // 0..3 over 4 s
  float freq = base * ratio_for(step);

  float note = fract(time * 4.0);   // 0..1 within each 1/4 s step
  float env = exp(-5.0 * note);
  float v = 0.4 * env * sin(6.2831853 * freq * time);
  return vec2(v, v);
}
