/* Compile and call the actual upstream policy, extracted after patching. */
#include <assert.h>
#include <stdbool.h>
#include <math.h>
#include <stdio.h>
static unsigned checks, failures;
static void check(int actual, int expected, int line) {
    checks++;
    if (actual != expected) { failures++; fprintf(stderr, "output-scale line %d: got %d expected %d\n", line, actual, expected); }
}
#define EXPECT(actual, expected) check((actual), (expected), __LINE__)
#define WLR_OUTPUT_STATE_MODE 1
#define WLR_OUTPUT_STATE_TRANSFORM 2
#define WLR_OUTPUT_STATE_MODE_FIXED 1
#define WLR_OUTPUT_STATE_MODE_CUSTOM 2
struct wlr_box { int width, height; };
enum wl_output_transform { NORMAL, ROTATE_90 };
struct wlr_output_mode { int width, height; };
struct wlr_output { int width, height, phys_width, phys_height; enum wl_output_transform transform; };
struct wlr_output_state {
    unsigned committed;
    int mode_type;
    struct wlr_output_mode *mode;
    struct { int width, height; } custom_mode;
    enum wl_output_transform transform;
};
static __attribute__((unused)) void wlr_box_transform(struct wlr_box *out, const struct wlr_box *in,
        enum wl_output_transform transform, int width, int height) {
    (void)in;
    *out = transform == NORMAL ? (struct wlr_box){width, height} : (struct wlr_box){height, width};
}
/* UPSTREAM_OUTPUT_SCALE */
static int scale(int width, int height, int mm_width, int mm_height) {
    struct wlr_output output = {width, height, mm_width, mm_height, NORMAL};
    struct wlr_output_state pending = {0};
    return compute_default_scale(&output, &pending);
}
int main(void) {
    /* Same 800x500 CSS pane at 1x and 2x; 2x height is below 1200. */
    EXPECT(scale(800, 500, 212, 132), 1);
    EXPECT(scale(1600, 1000, 212, 132), 2);
    /* Integer-mm rounding puts one axis on either side of 192 DPI. */
    EXPECT(scale(2176, 1226, 288, 162), 2);
    EXPECT(scale(2176, 1226, 287, 163), 2);
    EXPECT(scale(2880, 1620, 381, 214), 2);
    EXPECT(scale(1088, 612, 288, 162), 1);
    EXPECT(scale(2400, 1500, 212, 132), 3);
    EXPECT(scale(800, 500, 400, 250), 1);
    EXPECT(scale(1600, 1000, 0, 132), 1);
    EXPECT(scale(1600, 1000, 212, 0), 1);
    EXPECT(scale(1600, 1000, -212, 132), 1);
    EXPECT(scale(1600, 1000, 212, -132), 1);
    EXPECT(scale(3200, 1800, 160, 90), 1);
    EXPECT(scale(3200, 2000, 16, 10), 1);
    EXPECT(scale(0, 500, 212, 132), 1);
    /* The pending chosen mode, not the old mode, controls scale. */
    struct wlr_output output = {800, 500, 212, 132, NORMAL};
    struct wlr_output_mode mode = {1600, 1000};
    struct wlr_output_state pending = {.committed=WLR_OUTPUT_STATE_MODE, .mode_type=WLR_OUTPUT_STATE_MODE_FIXED, .mode=&mode};
    EXPECT(compute_default_scale(&output, &pending), 2);
    pending.mode_type=WLR_OUTPUT_STATE_MODE_CUSTOM;
    pending.custom_mode.width=800; pending.custom_mode.height=500;
    EXPECT(compute_default_scale(&output, &pending), 1);
    pending.mode_type=WLR_OUTPUT_STATE_MODE_FIXED;
    pending.committed |= WLR_OUTPUT_STATE_TRANSFORM;
    pending.transform = ROTATE_90;
    EXPECT(compute_default_scale(&output, &pending), 2);
    printf("output-scale: %u cases, %u failures\n", checks, failures);
    return failures != 0;
}
