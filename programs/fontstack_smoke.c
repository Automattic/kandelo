/*
 * fontstack_smoke — PR19 proof that the whole wasm32 font stack
 * (freetype + fontconfig + fcft over pixman) loads a real TTF and
 * rasterizes a glyph against the kernel's libc, with nothing mocked.
 *
 * This is the path foot takes for every cell it draws: fontconfig
 * resolves "monospace" through the staged fonts.conf (FONTCONFIG_FILE
 * points at it), freetype opens the TTF it names, and fcft rasterizes
 * into an a8 pixman image.
 *
 *   [FONT]  fcft_from_name("monospace") resolves via fontconfig.
 *   [GLYPH] 'A' rasterizes with nonzero ink coverage.
 *
 * Prints one line per checkpoint and "FONTSTACK_SMOKE_OK" on success;
 * exits non-zero on any failure. host/test/fontstack-smoke.test.ts
 * stages the config + font and asserts the markers.
 */
#include <stdio.h>
#include <fcft/fcft.h>

int main(void) {
    if (!fcft_init(FCFT_LOG_COLORIZE_NEVER, false, FCFT_LOG_CLASS_ERROR)) {
        fprintf(stderr, "fcft_init failed\n");
        return 1;
    }

    const char *names[] = { "monospace:size=16" };
    struct fcft_font *font = fcft_from_name(1, names, NULL);
    if (!font) { fprintf(stderr, "fcft_from_name failed\n"); return 1; }
    printf("[FONT] height=%d ascent=%d\n", font->height, font->ascent);

    const struct fcft_glyph *glyph =
        fcft_rasterize_char_utf32(font, 'A', FCFT_SUBPIXEL_NONE);
    if (!glyph || !glyph->pix) {
        fprintf(stderr, "rasterize failed\n");
        return 1;
    }

    int stride = pixman_image_get_stride(glyph->pix);
    int height = pixman_image_get_height(glyph->pix);
    const uint8_t *data = (const uint8_t *)pixman_image_get_data(glyph->pix);
    long ink = 0;
    for (long i = 0; i < (long)stride * height; i++)
        if (data[i]) ink++;
    printf("[GLYPH] w=%d h=%d ink=%ld\n", glyph->width, glyph->height, ink);
    if (glyph->width <= 0 || glyph->height <= 0 || ink == 0) return 1;

    fcft_destroy(font);
    fcft_fini();
    printf("FONTSTACK_SMOKE_OK\n");
    return 0;
}
