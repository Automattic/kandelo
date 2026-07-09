/*
 * programs/sdl2/audio.h — chip-synth + FFT analysis for the SDL2 GLSL
 * playground (Phase 5: audio + FFT + iAudio uniform).
 *
 * Two responsibilities, both single-threaded:
 *
 *   1. A 4-channel chiptune synth (square / square / saw / noise) over
 *      a 16-row looping pattern. `audio_synth_render` is the body of the
 *      SDL audio callback — under our SDL_THREADS_DISABLED + polling-
 *      audio stack the callback is pulled synchronously from the main
 *      loop's SDL_PumpAudioDevices(), so there is no writer thread and
 *      no locking is needed.
 *
 *   2. A rolling analysis ring of the most recent mono samples the synth
 *      produced. `audio_compute_spectrum` runs a 1024-point real FFT
 *      over that ring and log-bins the magnitude into 128 bytes ready to
 *      upload as the `iAudio` GL_LUMINANCE 1D texture.
 *
 * The plan named KISSFFT; we use a compact self-authored radix-2 FFT
 * instead — a fixed 1024-point transform is a few dozen lines, keeps the
 * playground "all code we wrote", and avoids a third_party vendor +
 * license tail + build wiring.
 */
#pragma once

#include <stdint.h>

/* Number of log-spaced magnitude bins exposed to the shader. Matches
 * the width of the iAudio texture and the bar count in audio_bars.frag. */
#define AUDIO_SPECTRUM_BINS 128

/* Prepare the synth for a device running at `sample_rate` Hz with
 * `channels` interleaved S16 channels (1 = mono, 2 = stereo). Resets the
 * pattern to row 0 and clears the analysis ring. Safe to call before the
 * device is unpaused. */
void audio_synth_init(int sample_rate, int channels);

/* SDL audio-callback body: fill `len` bytes of `stream` with interleaved
 * S16 samples from the synth, and copy the mono mix into the analysis
 * ring. When muted, writes silence to `stream` and zeros into the ring
 * (so the visualizer flattens) but still advances the pattern so the
 * tune resumes in place on unmute. */
void audio_synth_render(uint8_t *stream, int len);

/* Compute the 128-bin log-spaced magnitude spectrum of the most recent
 * audio into `bins` (each 0..255, ready for a GL_LUMINANCE upload). */
void audio_compute_spectrum(uint8_t bins[AUDIO_SPECTRUM_BINS]);

/* Mute toggles output + analysis; the pattern keeps advancing. */
void audio_set_muted(int muted);
int  audio_muted(void);

/* Phase 6: switch the playback source to a sound-shader-rendered S16
 * stereo buffer (looped). `pcm` points at `frames` interleaved stereo
 * frames and must stay valid until the next call. Passing pcm=NULL or
 * frames<=0 reverts to the built-in chip synth. The analysis ring (and
 * thus the iAudio visualizer) tracks whichever source is active. */
void audio_set_sound_pcm(const int16_t *pcm, int frames);
