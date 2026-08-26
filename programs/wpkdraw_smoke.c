/* wpkdraw Phase-1 gate: raster into a plain heap buffer (no compositor,
 * no KMS) and self-report so host/test/wpkdraw-smoke.test.ts can assert
 * pixels without a framebuffer.
 *
 * Wraps a heap buffer as a wpk_surface, clears it, fills a red rect, and
 * renders "OK" text; then dumps a sampled rect pixel + the glyph coverage
 * (non-black pixels in the text box). */
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    const int W = 128, H = 64, STRIDE = W * 4;
    uint32_t *buf = malloc((size_t)STRIDE * H);
    if (!buf) { perror("malloc"); return 1; }

    struct wpk_surface s = wpk_surface_wrap(buf, W, H, STRIDE);
    wpk_clear(&s, WPK_RGB(0, 0, 0));

    /* Opaque red rect at (10,10)–(30,30); sample its centre. */
    wpk_rect(&s, 10, 10, 20, 20, WPK_RGB(255, 0, 0));
    printf("RECT_PX x=15 y=15 px=0x%08x\n", buf[15 * W + 15]);

    struct wpk_font *f = wpk_font_load_default(16);
    if (!f) { perror("wpk_font_load_default"); free(buf); return 1; }
    int tw = wpk_text_width(f, "OK");
    printf("TEXT_WIDTH s=OK w=%d\n", tw);

    /* Render text well clear of the rect, then count lit pixels in its box. */
    const int tx = 60, baseline = 40;
    wpk_text(&s, f, tx, baseline, "OK", WPK_RGB(255, 255, 255));

    int y0 = baseline - wpk_font_ascent_px(f) - 2; if (y0 < 0) y0 = 0;
    int y1 = baseline + 4;                         if (y1 > H) y1 = H;
    int x0 = tx - 2;                               if (x0 < 0) x0 = 0;
    int x1 = tx + tw + 4;                          if (x1 > W) x1 = W;
    int coverage = 0;
    for (int y = y0; y < y1; y++)
        for (int x = x0; x < x1; x++)
            if (buf[y * W + x] & 0x00ffffffu) coverage++;
    printf("GLYPH_COVERAGE n=%d\n", coverage);

    /* AA primitives over black: fringe pixels blend to intermediate
     * channel values, which hard-edged wpk_rect can never produce. Core
     * samples sit well inside the shape and must be fully saturated. */
    wpk_line_aa(&s, 40.0f, 50.0f, 90.0f, 58.0f, 3.0f, WPK_RGB(0, 255, 0));
    int line_fringe = 0;
    for (int y = 46; y < 62; y++)
        for (int x = 36; x < 94; x++) {
            uint32_t g = (buf[y * W + x] >> 8) & 0xff;
            if (g > 0 && g < 0xff) line_fringe++;
        }
    printf("AA_LINE core=0x%08x fringe=%d\n", buf[54 * W + 65], line_fringe);

    wpk_disc_aa(&s, 105.0f, 20.0f, 6.0f, WPK_RGB(0, 0, 255));
    int disc_fringe = 0;
    for (int y = 12; y < 28; y++)
        for (int x = 97; x < 113; x++) {
            uint32_t b = buf[y * W + x] & 0xff;
            if (b > 0 && b < 0xff) disc_fringe++;
        }
    printf("AA_DISC core=0x%08x fringe=%d\n", buf[20 * W + 105], disc_fringe);

    wpk_font_destroy(f);
    free(buf);
    printf("WPKDRAW_SMOKE_OK\n");
    return 0;
}
