/* Render SVGs through librsvg's C API on Kandelo and check the pixels.
 * Prints one line per check and "RSVG RENDER OK" when all pass.
 *
 * Usage: render-check [<shapes.png> [<text.png>]]
 * Text rendering needs a font: run with FONTCONFIG_FILE naming a config
 * that provides "Inconsolata". */
#include <librsvg/rsvg.h>
#include <cairo.h>
#include <stdio.h>
#include <string.h>

static int failures;

static void check(int ok, const char *what) {
    printf("%s %s\n", ok ? "ok" : "FAIL", what);
    if (!ok) failures++;
}

static RsvgHandle *load(const char *svg) {
    GError *err = NULL;
    RsvgHandle *h = rsvg_handle_new_from_data((const guint8 *)svg, strlen(svg), &err);
    if (!h) {
        printf("load failed: %s\n", err->message);
        g_error_free(err);
    }
    return h;
}

static cairo_surface_t *render(RsvgHandle *h, int w, int hgt) {
    GError *err = NULL;
    cairo_surface_t *s = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, w, hgt);
    cairo_t *cr = cairo_create(s);
    RsvgRectangle vp = { 0, 0, w, hgt };
    if (!rsvg_handle_render_document(h, cr, &vp, &err)) {
        printf("render failed: %s\n", err->message);
        g_error_free(err);
    }
    cairo_destroy(cr);
    cairo_surface_flush(s);
    return s;
}

static unsigned pixel(cairo_surface_t *s, int x, int y) {
    unsigned char *d = cairo_image_surface_get_data(s);
    return *(unsigned *)(d + y * cairo_image_surface_get_stride(s) + x * 4);
}

static const char shapes_svg[] =
    "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='32'>"
    "<rect x='0' y='0' width='32' height='32' fill='#ff0000'/>"
    "<circle cx='48' cy='16' r='12' fill='rgb(0,0,255)' stroke='lime' stroke-width='2'/>"
    "</svg>";

static const char text_svg[] =
    "<svg xmlns='http://www.w3.org/2000/svg' width='160' height='40'>"
    "<text x='4' y='30' font-family='Inconsolata' font-size='28' fill='black'>Kandelo</text>"
    "</svg>";

int main(int argc, char **argv) {
    printf("librsvg %d.%d.%d\n", LIBRSVG_MAJOR_VERSION, LIBRSVG_MINOR_VERSION,
           LIBRSVG_MICRO_VERSION);

    RsvgHandle *h = load(shapes_svg);
    check(h != NULL, "load shapes");
    if (!h) return 1;
    gdouble w = 0, hh = 0;
    check(rsvg_handle_get_intrinsic_size_in_pixels(h, &w, &hh) && w == 64 && hh == 32,
          "intrinsic size 64x32");
    cairo_surface_t *s = render(h, 64, 32);
    check(pixel(s, 10, 10) == 0xffff0000u, "rect is opaque red");
    check(pixel(s, 48, 16) == 0xff0000ffu, "circle is opaque blue");
    check(pixel(s, 33, 1) == 0, "background is transparent");
    if (argc > 1)
        check(cairo_surface_write_to_png(s, argv[1]) == CAIRO_STATUS_SUCCESS, "write PNG");
    GError *err = NULL;
    GdkPixbuf *pb = rsvg_handle_get_pixbuf_and_error(h, &err);
    check(pb && gdk_pixbuf_get_width(pb) == 64 && gdk_pixbuf_get_height(pb) == 32,
          "GdkPixbuf 64x32");
    if (pb) g_object_unref(pb);
    cairo_surface_destroy(s);
    g_object_unref(h);

    /* Text goes through pango, harfbuzz, fontconfig and freetype. */
    h = load(text_svg);
    check(h != NULL, "load text");
    if (h) {
        s = render(h, 160, 40);
        int inked = 0, inked_left = 0, inked_right = 0;
        for (int y = 0; y < 40; y++)
            for (int x = 0; x < 160; x++)
                if ((pixel(s, x, y) >> 24) > 0x80) {
                    inked++;
                    if (x < 60) inked_left++;
                    else inked_right++;
                }
        printf("text: %d inked pixels (%d left, %d right)\n", inked, inked_left, inked_right);
        /* Seven glyphs at 28px span ~100px (about 490 inked pixels with
         * Inconsolata): ink on both sides of x=60, not one glyph's worth. */
        check(inked > 250 && inked_left > 80 && inked_right > 80, "text is drawn");
        if (argc > 2)
            check(cairo_surface_write_to_png(s, argv[2]) == CAIRO_STATUS_SUCCESS, "write text PNG");
        cairo_surface_destroy(s);
        g_object_unref(h);
    }

    RsvgHandle *bad = rsvg_handle_new_from_data((const guint8 *)"<svg", 4, NULL);
    check(bad == NULL, "malformed input is rejected");

    printf("%s\n", failures ? "RSVG RENDER FAILED" : "RSVG RENDER OK");
    return failures ? 1 : 0;
}
