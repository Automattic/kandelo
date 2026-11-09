/* Execute upstream's actual initial output configuration with a native
 * backend boundary. This detects the old scale=1 behavior before the patch. */
#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
#define WLR_OUTPUT_STATE_MODE 1
#define WLR_OUTPUT_STATE_MODE_FIXED 0
#define WLR_OUTPUT_STATE_MODE_CUSTOM 1
#define LAB_ADAPTIVE_SYNC_ENABLED 1
#define WLR_DEBUG 0
#define WLR_INFO 1
#define wlr_log(...) ((void)0)

struct wlr_output_mode { int width, height; };
struct wlr_output {
    int width, height, phys_width, phys_height;
    float scale;
};
struct wlr_output_state {
    bool enabled;
    uint32_t committed;
    int mode_type;
    struct wlr_output_mode *mode;
    struct { int width, height; } custom_mode;
    float scale;
};
struct output {
    struct wlr_output *wlr_output;
    struct wlr_output_state pending;
    struct output *scene_output;
    struct { int width, height; } usable_area;
};
static struct { int pending_output_layout_change; } server;
static struct { int adaptive_sync; } rc;
static bool allow_auto_mode = true, allow_scaled_state = true;
static unsigned commits, tests, layouts;

static void wlr_output_state_set_enabled(struct wlr_output_state *s, bool value) {
    s->enabled = value;
}
static bool output_test_auto(struct wlr_output *o, struct wlr_output_state *s,
        bool client_request) {
    (void)o; (void)s;
    assert(!client_request);
    return allow_auto_mode;
}
static void wlr_output_state_set_scale(struct wlr_output_state *s, float scale) {
    s->scale = scale;
}
static bool wlr_output_test_state(struct wlr_output *o,
        struct wlr_output_state *s) {
    (void)o;
    assert(commits == 0 && layouts == 0 && s->scale >= 1);
    ++tests;
    return allow_scaled_state;
}
static void output_enable_adaptive_sync(struct output *o, bool enabled) {
    (void)o; (void)enabled;
}
static void output_state_setup_hdr(struct output *o, bool enabled) {
    (void)o; (void)enabled;
}
static void add_output_to_layout(struct output *o) {
    o->scene_output = o;
    ++layouts;
}
static void wlr_output_schedule_frame(struct wlr_output *o) { (void)o; }
static void lab_wlr_scene_output_commit(struct output *o,
        struct wlr_output_state *s) {
    assert(s->enabled && layouts == 1);
    ++commits;
    o->wlr_output->scale = s->scale;
}
static void wlr_output_effective_resolution(struct wlr_output *o, int *w, int *h) {
    *w = o->width / o->scale;
    *h = o->height / o->scale;
}

/* UPSTREAM_OUTPUT_CONFIGURATION */

int main(void) {
    /* Older upstream does not call these backend boundaries yet. */
    (void)wlr_output_state_set_scale;
    (void)wlr_output_test_state;
    struct scale_case {
        const char *name;
        int width, height, mm_width, mm_height;
        float expected;
    } cases[] = {
        {"1x small pane", 800, 500, 212, 132, 1},
        {"2x small pane", 1600, 1000, 212, 132, 2},
        {"2x rounded mm", 2176, 1226, 288, 162, 2},
        {"2x rounded mm alternate", 2176, 1226, 287, 163, 2},
        {"exact 192 DPI", 1920, 1152, 254, 152, 2},
        {"retina native", 2880, 1620, 381, 214, 2},
        {"unequal density uses lower axis", 1600, 1000, 212, 265, 1},
        {"zero physical width", 1600, 1000, 0, 132, 1},
        {"negative physical height", 1600, 1000, 212, -1, 1},
        {"aspect only 1600x900", 3840, 2160, 1600, 900, 1},
        {"aspect only 1600x1000", 3840, 2160, 1600, 1000, 1},
        {"aspect only 160x90", 3840, 2160, 160, 90, 1},
        {"aspect only 160x100", 3840, 2160, 160, 100, 1},
        {"aspect only 16x9", 3840, 2160, 16, 9, 1},
        {"aspect only 16x10", 3840, 2160, 16, 10, 1},
        {"no mode width", 0, 1000, 212, 132, 1},
        {"no mode height", 1600, 0, 212, 132, 1},
    };
    unsigned failed = 0, checked = 0;
    for (size_t i = 0; i < ARRAY_SIZE(cases); ++i) {
        /* Existing mode, pending fixed mode, and pending custom mode must
         * all use native pixel axes, before any logical output transform. */
        for (int mode_kind = 0; mode_kind < 3; ++mode_kind) {
            const struct scale_case *c = &cases[i];
            struct wlr_output_mode mode = {c->width, c->height};
            struct wlr_output native = {
                c->width, c->height, c->mm_width, c->mm_height, 1,
            };
            struct output output = {
                .wlr_output = &native, .pending = {.scale = 1},
            };
            if (mode_kind != 0) {
                native.width = native.height = 0;
                output.pending.committed = WLR_OUTPUT_STATE_MODE;
                output.pending.mode_type = mode_kind == 1
                    ? WLR_OUTPUT_STATE_MODE_FIXED : WLR_OUTPUT_STATE_MODE_CUSTOM;
                output.pending.mode = mode_kind == 1 ? &mode : NULL;
                output.pending.custom_mode.width = c->width;
                output.pending.custom_mode.height = c->height;
            }
            commits = tests = layouts = 0;
            configure_new_output(&output);
            ++checked;
            if (native.scale != c->expected || commits != 1) {
                fprintf(stderr, "%s, mode %d: expected scale %.0f, got %.0f\n",
                    c->name, mode_kind, c->expected, native.scale);
                ++failed;
            }
        }
    }
    struct wlr_output native = {1600, 1000, 212, 132, 1};
    struct output output = {.wlr_output = &native, .pending = {.scale = 1}};
    commits = tests = layouts = 0;
    allow_auto_mode = false;
    configure_new_output(&output);
    assert(commits == 0 && layouts == 0 && !output.pending.enabled);
    allow_auto_mode = true;
    allow_scaled_state = false;
    configure_new_output(&output);
    if (commits != 0 || layouts != 0 || output.pending.enabled || tests != 1) {
        fputs("rejected initial scaled state reached native commit\n", stderr);
        ++failed;
    }
    printf("labwc initial scale: %u mode cases, two backend failure controls, %u failed\n",
        checked, failed);
    return failed != 0;
}
