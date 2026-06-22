// Phase 6 sound preset: an FM bell that retriggers once per second.
// Two-operator frequency modulation — a sine carrier whose phase is
// modulated by a higher-frequency sine. The modulation index and the
// amplitude both decay across each one-second note (via fract(time)),
// giving the bright-attack / mellow-tail timbre of a struck bell.
// See programs/sdl2/sound_shader.c for the mainSound contract.

vec2 mainSound(in float time) {
  float note = fract(time);                 // 0..1 within each second
  float carrier = 440.0;
  float modulator = 880.0;
  float index = 5.0 * exp(-3.0 * note);     // FM brightness decays
  float env   = exp(-3.5 * note);           // amplitude decays
  float phase = 6.2831853 * carrier * time
              + index * sin(6.2831853 * modulator * time);
  float v = 0.4 * env * sin(phase);
  return vec2(v, v);
}
