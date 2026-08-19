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

