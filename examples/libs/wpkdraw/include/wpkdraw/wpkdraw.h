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

/* A drawable target over caller memory. Plain descriptor — no lifecycle:
 * copy it, stack-allocate it, throw it away. `stride` is bytes per row
 * (>= w*4); the allocator behind a wl_shm buffer may pad rows. */
struct wpk_surface {
    uint32_t *pixels;
    int w, h;
    int stride;
};

/* Wrap caller memory as a surface. Pass stride == 0 for a tightly-packed
 * buffer (w*4). */
struct wpk_surface wpk_surface_wrap(uint32_t *pixels, int w, int h, int stride);

/* Fill the whole surface with one colour (overwrite, no blend). */
void wpk_clear(struct wpk_surface *s, wpk_color color);

/* Plot one pixel, alpha-blended if color's alpha < 0xff. Out-of-bounds
 * writes are silently clipped. */
void wpk_pixel(struct wpk_surface *s, int x, int y, wpk_color color);

/* Filled rect over columns [x, x+w) and rows [y, y+h), alpha-blended.
 * Negative/zero w or h is a no-op. */
void wpk_rect(struct wpk_surface *s, int x, int y, int w, int h,
              wpk_color color);

#endif /* WPKDRAW_H */
