/* wpkdraw 2D primitives — see include/wpkdraw/wpkdraw.h. */
#include <wpkdraw/wpkdraw.h>

/* Alpha-blend src over dst, both ARGB8888. */
static inline uint32_t blend(uint32_t dst, uint32_t src) {
    uint32_t a = src >> 24;
    if (a == 0xff) return src;
    if (a == 0) return dst;
    uint32_t inv = 255 - a;
    uint32_t dr = (dst >> 16) & 0xff, dg = (dst >> 8) & 0xff,
             db = dst & 0xff, da = dst >> 24;
    uint32_t sr = (src >> 16) & 0xff, sg = (src >> 8) & 0xff, sb = src & 0xff;
    uint32_t r = (sr * a + dr * inv) / 255;
    uint32_t g = (sg * a + dg * inv) / 255;
    uint32_t b = (sb * a + db * inv) / 255;
    uint32_t fa = a + (da * inv) / 255;
    return (fa << 24) | (r << 16) | (g << 8) | b;
}

struct wpk_surface wpk_surface_wrap(uint32_t *pixels, int w, int h, int stride) {
    struct wpk_surface s;
    s.pixels = pixels;
    s.w = w;
    s.h = h;
    s.stride = stride > 0 ? stride : w * 4;
    return s;
}

void wpk_clear(struct wpk_surface *s, wpk_color color) {
    if (!s || !s->pixels) return;
    int stride_px = s->stride / 4;
    for (int y = 0; y < s->h; y++) {
        uint32_t *row = s->pixels + (size_t)y * stride_px;
        for (int x = 0; x < s->w; x++) row[x] = color;
    }
}

void wpk_pixel(struct wpk_surface *s, int x, int y, wpk_color color) {
    if (!s || !s->pixels) return;
    if (x < 0 || y < 0 || x >= s->w || y >= s->h) return;
    uint32_t *p = s->pixels + (size_t)y * (s->stride / 4) + x;
    *p = blend(*p, color);
}

void wpk_rect(struct wpk_surface *s, int x, int y, int w, int h,
              wpk_color color) {
    if (!s || !s->pixels || w <= 0 || h <= 0) return;
    int x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y;
    int x1 = x + w; if (x1 > s->w) x1 = s->w;
    int y1 = y + h; if (y1 > s->h) y1 = s->h;
    int stride_px = s->stride / 4;
    if ((color >> 24) == 0xff) {
        for (int py = y0; py < y1; py++) {
            uint32_t *row = s->pixels + (size_t)py * stride_px + x0;
            for (int px = x0; px < x1; px++) *row++ = color;
        }
    } else {
        for (int py = y0; py < y1; py++)
            for (int px = x0; px < x1; px++)
                wpk_pixel(s, px, py, color);
    }
}

/* --- Anti-aliased primitives ------------------------------------------
 *
 * Distance-field coverage: each pixel centre's distance to the shape
 * gives an approximate coverage in [0,1], which scales the colour's
 * alpha before the ordinary blend(). __builtin_sqrtf lowers to the
 * native wasm `f32.sqrt` instruction, so this stays libm-free (wlclock
 * and friends link no libm — see programs/wlclock.c). */

static inline float clamp01(float v) {
    return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
}

static void blend_coverage(struct wpk_surface *s, int x, int y,
                           wpk_color color, float cov) {
    if (cov <= 0.0f) return;
    if (cov > 1.0f) cov = 1.0f;
    uint32_t a = (uint32_t)((float)(color >> 24) * cov + 0.5f);
    if (a == 0) return;
    wpk_pixel(s, x, y, (a << 24) | (color & 0x00ffffffu));
}

void wpk_line_aa(struct wpk_surface *s, float x0, float y0,
                 float x1, float y1, float width, wpk_color color) {
    if (!s || !s->pixels || width <= 0.0f) return;
    float halfw = width * 0.5f;

    /* Bounding box, padded one pixel for the AA fringe. */
    float pad = halfw + 1.0f;
    float bx0 = (x0 < x1 ? x0 : x1) - pad, bx1 = (x0 > x1 ? x0 : x1) + pad;
    float by0 = (y0 < y1 ? y0 : y1) - pad, by1 = (y0 > y1 ? y0 : y1) + pad;
    int ix0 = (int)bx0, iy0 = (int)by0;
    int ix1 = (int)bx1 + 1, iy1 = (int)by1 + 1;
    if (ix0 < 0) ix0 = 0;
    if (iy0 < 0) iy0 = 0;
    if (ix1 > s->w) ix1 = s->w;
    if (iy1 > s->h) iy1 = s->h;

    float vx = x1 - x0, vy = y1 - y0;
    float len2 = vx * vx + vy * vy;

    for (int py = iy0; py < iy1; py++) {
        for (int px = ix0; px < ix1; px++) {
            /* Distance from the pixel centre to the segment (capsule). */
            float wx = (float)px + 0.5f - x0, wy = (float)py + 0.5f - y0;
            float t = len2 > 0.0f ? clamp01((wx * vx + wy * vy) / len2) : 0.0f;
            float dx = wx - t * vx, dy = wy - t * vy;
            float dist = __builtin_sqrtf(dx * dx + dy * dy);
            blend_coverage(s, px, py, color, halfw + 0.5f - dist);
        }
    }
}

void wpk_disc_aa(struct wpk_surface *s, float cx, float cy, float r,
                 wpk_color color) {
    /* A zero-length capsule of width 2r IS this disc — same bbox,
     * clamps and coverage as wpk_line_aa's degenerate case. */
    wpk_line_aa(s, cx, cy, cx, cy, 2.0f * r, color);
}

