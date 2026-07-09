// Phase 6 sound preset: a pure 220 Hz sine tone.
// A "sound shader" supplies `vec2 mainSound(in float time)` returning the
// (left, right) amplitude in [-1, 1] at `time` seconds. The host wraps
// this body with the GLSL ES 1.0 sound template from
// programs/sdl2/sound_shader.c, renders it to an FBO, reads it back, and
// plays the decoded PCM through ALSA. The image shader's iAudio uniform
// then visualizes this output's FFT — edit the sound, watch the picture.
//
// Kept in sync with BUILTIN_SOUND_SRC in programs/sdl2/main.c.

vec2 mainSound(in float time) {
  float v = 0.3 * sin(6.2831853 * 220.0 * time);
  return vec2(v, v);
}
