/*
 * programs/sdl2/sound_shader.h — Shadertoy-style "sound shader" support
 * for the SDL2 GLSL playground (Phase 6: closed loop).
 *
 * A sound shader supplies `vec2 mainSound(in float time)` returning the
 * (left, right) amplitude in [-1, 1] at `time` seconds. We wrap it in a
 * GLSL ES 1.0 template that turns each framebuffer pixel into one stereo
 * frame: the fragment computes its sample index from gl_FragCoord,
 * evaluates mainSound, and encodes the result as RGBA8 (L → r,g and
 * R → b,a, 16-bit split). Rendering the whole FBO once therefore
 * produces SOUND_SHADER_FRAMES stereo frames in a single dispatch; we
 * then glReadPixels the FBO back (in <=64 KB row-bands, the kernel's
 * MAX_QUERY_OUT_LEN cap) and decode RGBA8 → S16. The decoded buffer is
 * handed to audio.c, which loops it as the playback source.
 *
 * GL ownership note: like renderer.c this module talks GLES2 directly.
 * It keeps its own program / FBO / VBO so the image-shader pipeline in
 * renderer.c is untouched. Under the headless Node GL stub glReadPixels
 * is a no-op (host_gl_query returns -1), so the decoded buffer stays
 * silent and sound_shader_render reports 0 frames — audio.c then falls
 * back to the chip synth. Real audio only materializes on the browser
 * host with a live WebGL context.
 */
#pragma once

#include <stdint.h>

/* FBO geometry. The FBO holds ONE tile = SOUND_SHADER_TILE_FRAMES stereo
 * frames (1024×1024 = 1048576 ≈ 21.85 s at 48 kHz). A single heavy
 * mainSound (e.g. the Tunnelwisp boot default) rendered across the whole
 * track in one dispatch would trip the GPU watchdog, so sound_shader_render
 * renders SOUND_SHADER_TILES tiles in sequence, advancing the iBufferOffset
 * uniform by one tile's worth of seconds each time, and concatenates the
 * read-back PCM. 13 tiles ≈ 284 s — long enough to play the (~4.5 min,
 * one-shot) track out to where every voice has faded, so the loop back to
 * t=0 is clean rather than an abrupt mid-phrase cut.
 *
 * The decoded S16 stereo buffer is SOUND_SHADER_FRAMES*2*2 bytes ≈ 54 MiB,
 * malloc'd once at init (not static BSS). Each tile's readback is still
 * chunked into <=64 KB row-bands for the kernel's MAX_QUERY_OUT_LEN cap. */
#define SOUND_SHADER_TEX_W      1024
#define SOUND_SHADER_TEX_H      1024
#define SOUND_SHADER_TILES      13
#define SOUND_SHADER_TILE_FRAMES (SOUND_SHADER_TEX_W * SOUND_SHADER_TEX_H)
#define SOUND_SHADER_FRAMES     (SOUND_SHADER_TILE_FRAMES * SOUND_SHADER_TILES)

/* Create the GL program scaffold (FBO, attachment texture, quad VBO) and
 * compile a known-good default sine shader. Call once after the GL
 * context is current. */
void sound_shader_init(void);
void sound_shader_shutdown(void);

/* Compile `user_src` (a `mainSound` body) into the sound program. Mirrors
 * renderer_recompile_user_shader: returns 1 on a real compile/link
 * failure (last-good program retained, error stashed), 0 on success or a
 * headless empty-log failure. */
int sound_shader_recompile(const char *user_src);

/* Render the current sound program to the FBO and read it back, decoding
 * RGBA8 → S16 stereo into the internal buffer. Returns the number of
 * stereo frames decoded, or 0 if there is no program or the readback
 * produced all-zero pixels (headless / silent). `sample_rate` sets the
 * iSampleRate uniform so the shader's `time` axis matches playback. */
int sound_shader_render(int sample_rate);

/* Borrow the most recently decoded S16 stereo buffer. `*out_frames` is
 * set to the frame count from the last sound_shader_render. The pointer
 * is stable for the life of the module; its contents change on each
 * render. Returns NULL with *out_frames=0 before the first render. */
const int16_t *sound_shader_pcm(int *out_frames);

const char *sound_shader_last_error(void);

/* 1-indexed user-source line of the last sound-shader compile error
 * (template prefix already subtracted), or -1 if none/unmappable. */
int sound_shader_last_error_line(void);
