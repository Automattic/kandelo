// Phase 6 sound preset: white noise under a slow amplitude sweep.
// A cheap hash turns the per-sample time index into pseudo-random noise;
// a slow LFO sweeps the level so the FFT visualizer shows a broadband
// wash rising and falling. Good for confirming iAudio reacts across the
// whole spectrum (vs the single bins a sine lights up).
// See programs/sdl2/sound_shader.c for the mainSound contract.

float hash(float n) { return fract(sin(n) * 43758.5453123); }

vec2 mainSound(in float time) {
  // ~quantize to a noise rate so adjacent samples decorrelate.
  float n = hash(floor(time * 12000.0)) * 2.0 - 1.0;
  float sweep = 0.5 + 0.5 * sin(6.2831853 * 0.2 * time);
  float v = 0.3 * n * sweep;
  return vec2(v, v);
}
