/*
 * programs/sdl2/renderer.h — GLES2 drawing facade for the SDL2 GLSL
 * playground. Owns three GL programs and the font atlas:
 *
 *   1. The user image-shader program (PLASMA_SRC fallback + the
 *      `mainImage`/Shadertoy-shape wrapper from Phase 2/3). Hot-swapped
 *      on every successful recompile; on a failed recompile the last
 *      good handle is retained.
 *   2. A translucent red strip drawn at the bottom of the right pane
 *      when `renderer_set_error_visible(1)` is in effect.
 *   3. A textured-quad program for the editor: glyphs are baked once
 *      at startup from the vendored Inconsolata-Regular.ttf into a
 *      GL_LUMINANCE atlas via stb_truetype.
 *
 * The header is intentionally free of SDL2 and GLES2 includes so the
 * editor module (which only needs the text-rendering surface) doesn't
 * drag the GL toolchain in.
 */
#pragma once

#include <stddef.h>

void renderer_init(int screen_w, int screen_h);
void renderer_shutdown(void);

/* The whole-window drawable size — text rendering converts pixel
 * coordinates to NDC against this size. Call when SDL reports a new
 * drawable size (resize, DPI change). */
void renderer_set_screen_size(int w, int h);

/* User-shader pipeline ------------------------------------------------
 *
 * `renderer_recompile_user_shader` wraps `user_src` in the Phase 2
 * GLSL ES 1.0 Shadertoy template and links a new program. On success
 * it swaps the active handle and re-binds the iResolution/iTime/etc
 * uniform locations; on a real failure (compile/link status==0 with a
 * non-empty info log) it deletes the broken program, leaves the last
 * good handle in place, stashes the failing source line for
 * renderer_last_error_line(), and returns 1. Empty-info-log failures —
 * the headless-GL stub that NodeKernelHost emits because host_gl_query
 * returns -1 — return 0 (warned but not "real"). */
int  renderer_recompile_user_shader(const char *user_src);

/* Draws the user image-shader over the [vp_x, vp_x+vp_w] × [vp_y,
 * vp_y+vp_h] sub-rectangle of the framebuffer. iResolution is the
 * sub-rectangle size; iViewportOrigin is (vp_x, vp_y) so the Shadertoy
 * `fragCoord / iResolution` idiom yields the standard 0..1 UVs even
 * though gl_FragCoord is window-absolute. */
void renderer_draw_user_shader(int vp_x, int vp_y, int vp_w, int vp_h,
                               float t, float dt,
                               float mouse_x, float mouse_y, int frame);

/* Draws the translucent red strip across the bottom 8% of the
 * (vp_x, vp_y, vp_w, vp_h) rectangle iff renderer_set_error_visible(1)
 * is in effect. The caller is expected to have the right-pane scissor
 * still active so the strip is clipped within it. */
void renderer_draw_error_strip(int vp_x, int vp_y, int vp_w, int vp_h);

void renderer_set_error_visible(int visible);

/* 1-indexed user-source line of the last image-shader compile error
 * (template prefix already subtracted), or -1 if none/unmappable. The
 * editor uses it to mark the failing line. Only meaningful right after a
 * recompile that returned a real failure. */
int  renderer_last_error_line(void);

/* Audio spectrum (iAudio) ---------------------------------------------
 *
 * Uploads `n` magnitude bytes as a single-row GL_LUMINANCE texture bound
 * to the user shader's `iAudio` sampler. The shader samples it as a 1D
 * lookup: `texture2D(iAudio, vec2(x, 0.0)).r` is the level at normalized
 * frequency x∈[0,1]. Call once per frame before renderer_draw_user_shader.
 * `n` is expected to be AUDIO_SPECTRUM_BINS (128). */
void renderer_set_audio_spectrum(const unsigned char *bins, int n);

/* Text rendering ------------------------------------------------------
 *
 * Inconsolata is rendered at a fixed pixel height; the atlas is built
 * once at init time. Coordinates are pixels with the origin at the
 * top-left of the window, matching the editor's mental model. */

int  renderer_text_advance(void);     /* monospace glyph cell width  */
int  renderer_text_line_height(void); /* total line stride (px)      */

/* Draw `n` ASCII bytes starting at the top-left pixel (x, y), in
 * solid (r, g, b). Returns the advance in pixels. Non-printable bytes
 * are silently skipped. Newlines are NOT handled — the editor renders
 * one call per visible line. */
int  renderer_draw_text(int x, int y, const char *s, size_t n,
                        float r, float g, float b);
int  renderer_draw_textz(int x, int y, const char *s,
                         float r, float g, float b);

/* Solid-color filled rectangle in window-pixel coordinates. Used for
 * the cursor, the gutter background, and any flat editor chrome. */
void renderer_fill_rect(int x, int y, int w, int h,
                        float r, float g, float b, float a);
