/*
 * pixman_smoke — PR19 proof that the wasm32 pixman port
 * (packages/registry/pixman) rasterizes with the generic C paths (every
 * SIMD backend disabled) against the kernel's libc, with nothing mocked.
 *
 * fcft composites glyphs through exactly this API: an a8r8g8b8
 * destination, solid-fill sources, and OP_OVER.
 *
 *   [FILL]  pixman_image_fill_rectangles paints the destination blue.
 *   [OVER]  an opaque red solid composited OP_OVER replaces it.
 *
 * Prints one line per checkpoint and "PIXMAN_SMOKE_OK" on success;
 * exits non-zero on any failure. host/test/pixman-smoke.test.ts asserts
 * the markers.
 */
#include <stdio.h>
#include <pixman.h>

#define W 4
#define H 4

int main(void) {
    printf("[VERSION] %s\n", pixman_version_string());

    pixman_image_t *dst =
        pixman_image_create_bits(PIXMAN_a8r8g8b8, W, H, NULL, 0);
    if (!dst) { fprintf(stderr, "create_bits failed\n"); return 1; }
    uint32_t *px = pixman_image_get_data(dst);

    pixman_color_t blue = { 0x0000, 0x0000, 0xffff, 0xffff };
    pixman_rectangle16_t whole = { 0, 0, W, H };
    if (!pixman_image_fill_rectangles(PIXMAN_OP_SRC, dst, &blue, 1, &whole)) {
        fprintf(stderr, "fill_rectangles failed\n");
        return 1;
    }
    printf("[FILL] px=0x%08x\n", px[0]);
    if (px[0] != 0xff0000ffu) return 1;

    pixman_color_t red = { 0xffff, 0x0000, 0x0000, 0xffff };
    pixman_image_t *src = pixman_image_create_solid_fill(&red);
    if (!src) { fprintf(stderr, "solid_fill failed\n"); return 1; }
    pixman_image_composite32(PIXMAN_OP_OVER, src, NULL, dst,
                             0, 0, 0, 0, 0, 0, W, H);
    printf("[OVER] px=0x%08x\n", px[W + 1]);
    if (px[W + 1] != 0xffff0000u) return 1;

    pixman_image_unref(src);
    pixman_image_unref(dst);
    printf("PIXMAN_SMOKE_OK\n");
    return 0;
}
