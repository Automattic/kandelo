/*
 * pango_cairo_smoke — PR23 proof that the wasm32 render stack
 * (pango + harfbuzz + fribidi over cairo image surfaces, on the PR19
 * freetype/fontconfig fonts) lays out and rasterizes text against the
 * kernel's libc, with nothing mocked.
 *
 * This is the path GTK3 takes for every label it draws: fontconfig
 * resolves "monospace" through the staged fonts.conf (FONTCONFIG_FILE
 * points at it), pango itemizes and shapes through harfbuzz, and
 * pangocairo renders the glyphs into an ARGB32 image surface.
 *
 *   [LAYOUT] the layout has nonzero pixel extents.
 *   [INK]    rendering inked pixels onto the white background.
 *   [HASH]   FNV-1a over the surface bytes — the pixel hash the test
 *            asserts; every pinned layer (font TTF, freetype, pango)
 *            feeds it.
 *
 * Prints one line per checkpoint and "PANGO_CAIRO_OK" on success;
 * exits non-zero on any failure. host/test/pango-cairo-smoke.test.ts
 * stages the config + font and asserts the markers.
 */
#include <stdio.h>
#include <stdint.h>
#include <pango/pangocairo.h>

#define SURFACE_W 256
#define SURFACE_H 64

int main(void) {
    cairo_surface_t *surface =
        cairo_image_surface_create(CAIRO_FORMAT_ARGB32, SURFACE_W, SURFACE_H);
    cairo_t *cr = cairo_create(surface);

    cairo_set_source_rgb(cr, 1.0, 1.0, 1.0);
    cairo_paint(cr);

    PangoLayout *layout = pango_cairo_create_layout(cr);
    PangoFontDescription *desc =
        pango_font_description_from_string("monospace 24");
    pango_layout_set_font_description(layout, desc);
    pango_font_description_free(desc);
    pango_layout_set_text(layout, "kandelo", -1);

    int width = 0, height = 0;
    pango_layout_get_pixel_size(layout, &width, &height);
    printf("[LAYOUT] w=%d h=%d\n", width, height);
    if (width <= 0 || height <= 0) return 1;

    cairo_set_source_rgb(cr, 0.0, 0.0, 0.0);
    cairo_move_to(cr, 8, 8);
    pango_cairo_show_layout(cr, layout);
    cairo_surface_flush(surface);

    const uint8_t *data = cairo_image_surface_get_data(surface);
    int stride = cairo_image_surface_get_stride(surface);
    long ink = 0;
    uint32_t hash = 2166136261u;
    for (int y = 0; y < SURFACE_H; y++) {
        const uint32_t *row = (const uint32_t *)(data + (long)y * stride);
        for (int x = 0; x < SURFACE_W; x++) {
            if ((row[x] & 0x00ffffffu) != 0x00ffffffu) ink++;
            hash = (hash ^ row[x]) * 16777619u;
        }
    }
    printf("[INK] n=%ld\n", ink);
    printf("[HASH] %08x\n", hash);
    if (ink == 0) return 1;

    g_object_unref(layout);
    cairo_destroy(cr);
    cairo_surface_destroy(surface);
    printf("PANGO_CAIRO_OK\n");
    return 0;
}
