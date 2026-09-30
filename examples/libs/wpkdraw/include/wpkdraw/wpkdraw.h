/* wpkdraw — thin CPU rasterizer for non-SDL2 Kandelo apps.
 *
 * Buffer-target only: every primitive writes into caller-owned
 * ARGB8888/XRGB8888 memory (a wl_shm back buffer, a heap scratch, …).
 * wpkdraw owns no framebuffer, no fd, no gbm_bo — the compositor owns
 * the screen. See docs/plans/2026-07-09-dri-pr7-libkwl-wlterm-plan.md §3.
 */
#ifndef WPKDRAW_H
#define WPKDRAW_H

#include <stdint.h>
#include <stddef.h>

/* ARGB8888 packed colour: MSB is alpha (0xff opaque, 0x00 transparent),
 * then red, green, blue. */
typedef uint32_t wpk_color;

#define WPK_RGB(r, g, b)     (0xff000000u | ((uint32_t)(r) << 16) \
                              | ((uint32_t)(g) << 8) | (uint32_t)(b))

/* Device pixels per logical unit. Every coordinate an app passes below is
 * logical, and every primitive multiplies by the surface's scale on the way
 * in — so an app laid out for a 1x display draws sharp on a 2x one without
 * touching a single coordinate.
 *
 * The scale is a process-wide setting because one process draws for one
 * output: wpk_surface_wrap() and wpk_font_load_default() each capture it at
 * call time. Set it BEFORE creating any surface or font (libkwl does, as
 * soon as it reads wl_output.scale). A program that never calls this — the
 * compositor, which composites in device pixels already — stays at 1 and
 * behaves exactly as before. Values below 1 clamp to 1. */
void wpk_set_scale(int scale);
int wpk_scale(void);

/* A drawable target over caller memory. Plain descriptor — no lifecycle:
 * copy it, stack-allocate it, throw it away. `w`/`h` are LOGICAL, so the
 * memory behind it is (w*scale) x (h*scale) pixels. `stride` is bytes per
 * DEVICE row (>= w*scale*4); the allocator behind a wl_shm buffer may pad
 * rows. */
struct wpk_surface {
    uint32_t *pixels;
    int w, h;
    int stride;
    int scale;
};

/* Wrap caller memory as a surface of w x h LOGICAL units at the current
 * wpk_scale(). Pass stride == 0 for a tightly-packed buffer. */
struct wpk_surface wpk_surface_wrap(uint32_t *pixels, int w, int h, int stride);

/* Fill the whole surface with one colour (overwrite, no blend). */
void wpk_clear(struct wpk_surface *s, wpk_color color);

/* Plot one logical pixel — a scale x scale block — alpha-blended if color's
 * alpha < 0xff. Out-of-bounds writes are silently clipped. */
void wpk_pixel(struct wpk_surface *s, int x, int y, wpk_color color);

/* Plot one DEVICE pixel, alpha-blended and clipped. For drawing code that
 * already holds device coordinates — the font engine blitting a glyph mask
 * rasterized at the scaled size. Everything else works in logical units. */
void wpk_pixel_device(struct wpk_surface *s, int x, int y, wpk_color color);

/* Filled rect over columns [x, x+w) and rows [y, y+h), alpha-blended.
 * Negative/zero w or h is a no-op. */
void wpk_rect(struct wpk_surface *s, int x, int y, int w, int h,
              wpk_color color);

/* Anti-aliased line from (x0,y0) to (x1,y1), `width` logical units thick
 * with round caps (a capsule). Edge pixels get the colour's alpha scaled by
 * their coverage, so shallow angles stay smooth. Coordinates are logical
 * pixel centres (a coordinate of 3.0 means the centre of column 3). The
 * coverage is computed after scaling, so a scaled line is smoother rather
 * than merely bigger. Zero or negative width is a no-op; a zero-length
 * segment draws a disc of diameter `width`. */
void wpk_line_aa(struct wpk_surface *s, float x0, float y0,
                 float x1, float y1, float width, wpk_color color);

/* Anti-aliased filled disc of radius `r` centred on (cx,cy), coverage
 * blended like wpk_line_aa. Zero or negative radius is a no-op. */
void wpk_disc_aa(struct wpk_surface *s, float cx, float cy, float r,
                 wpk_color color);

#endif /* WPKDRAW_H */
