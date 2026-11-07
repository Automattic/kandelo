/* Real upstream initial-output and explicit-request handlers; only the
 * backend/listener boundary is native. Run unchanged source as a failure
 * control, then patched source. No duplicate density calculation lives here. */
#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

#define WLR_HAS_DRM_BACKEND 0
#define WLR_DEBUG 0
#define WLR_ERROR 1
#define wlr_log(...) ((void)0)
#define CAGE_MULTI_OUTPUT_MODE_LAST 1
#define WLR_OUTPUT_STATE_MODE 1
#define WLR_OUTPUT_STATE_SCALE 2
#define WLR_OUTPUT_STATE_MODE_FIXED 0
#define WLR_OUTPUT_STATE_MODE_CUSTOM 1
struct wl_list { struct wl_list *prev, *next; };
struct wl_listener { struct wl_list link; void (*notify)(struct wl_listener *, void *); };
struct wl_signal { int unused; };
#define wl_container_of(ptr, sample, member) ((__typeof__(sample))((char *)(ptr) - offsetof(__typeof__(*(sample)), member)))
#define wl_list_for_each(pos, head, member) for (pos = (__typeof__(pos))(head)->next; &pos->member != (head); pos = (__typeof__(pos))pos->member.next)
static void wl_list_init(struct wl_list *list) { list->prev = list->next = list; }
static void wl_list_insert(struct wl_list *head, struct wl_list *entry) {
    entry->next = head->next; entry->prev = head; head->next->prev = entry; head->next = entry;
}
static bool wl_list_empty(struct wl_list *list) { return list->next == list; }
static size_t wl_list_length(struct wl_list *list) {
    size_t count = 0; for (struct wl_list *p = list->next; p != list; p = p->next) ++count; return count;
}
static void wl_signal_add(struct wl_signal *signal, struct wl_listener *listener) { (void)signal; (void)listener; }
struct wlr_output_mode { struct wl_list link; int width, height; };
struct wlr_output {
    int width, height, phys_width, phys_height; float scale;
    bool enabled, non_desktop; const char *name; void *data;
    struct wl_list modes;
    struct { struct wl_signal commit, request_state, destroy, frame; } events;
};
struct wlr_output_state {
    uint32_t committed; int mode_type; struct wlr_output_mode *mode;
    struct { int width, height; } custom_mode;
    float scale; bool enabled;
};
struct wlr_output_event_request_state { struct wlr_output_state *state; };
struct cg_seat { void *xcursor_manager; };
struct cg_server {
    struct wl_listener new_output; struct wl_list outputs;
    void *allocator, *renderer, *scene; struct cg_seat *seat; int output_mode;
};
struct cg_output {
    struct wl_list link; struct wlr_output *wlr_output; struct cg_server *server;
    struct wl_listener commit, request_state, destroy, frame; void *scene_output;
};
static bool allow_mode = true, allow_scale = true, allow_commit = true;
static struct wlr_output_mode *rejected_mode;
static unsigned commits, layouts, finishes, cursor_loads;
static float loaded_scale;
static bool wlr_output_init_render(struct wlr_output *o, void *allocator, void *renderer) { (void)o; (void)allocator; (void)renderer; return true; }
static void *wlr_scene_output_create(void *scene, struct wlr_output *o) { (void)scene; return o; }
static void wlr_output_state_set_enabled(struct wlr_output_state *s, bool value) { s->enabled = value; }
static struct wlr_output_mode *wlr_output_preferred_mode(struct wlr_output *o) { return (struct wlr_output_mode *)o->modes.next; }
static void wlr_output_state_set_mode(struct wlr_output_state *s, struct wlr_output_mode *m) { s->mode = m; s->committed |= WLR_OUTPUT_STATE_MODE; s->mode_type = WLR_OUTPUT_STATE_MODE_FIXED; }
static void wlr_output_state_set_scale(struct wlr_output_state *s, float scale) { s->scale = scale; s->committed |= WLR_OUTPUT_STATE_SCALE; }
static bool wlr_output_test_state(struct wlr_output *o, struct wlr_output_state *s) { (void)o; return allow_mode && (!rejected_mode || s->mode != rejected_mode) && (!(s->committed & WLR_OUTPUT_STATE_SCALE) || allow_scale); }
static bool wlr_output_commit_state(struct wlr_output *o, struct wlr_output_state *s) {
    ++commits;
    if (!allow_commit) return false;
    if (s->committed & WLR_OUTPUT_STATE_SCALE) o->scale = s->scale;
    if (s->committed & WLR_OUTPUT_STATE_MODE) { o->width = s->mode->width; o->height = s->mode->height; }
    o->enabled = s->enabled; return true;
}
static void wlr_output_state_finish(struct wlr_output_state *s) { (void)s; ++finishes; }
static bool wlr_xcursor_manager_load(void *manager, float scale) { (void)manager; ++cursor_loads; loaded_scale = scale; return true; }
static void output_layout_add_auto(struct cg_output *o) { (void)o; ++layouts; }
static void output_disable(struct cg_output *o) { (void)o; }
static void view_position_all(struct cg_server *s) { (void)s; }
static void update_output_manager_config(struct cg_server *s) { (void)s; }
static void handle_output_commit(struct wl_listener *l, void *p) { (void)l; (void)p; }
static void handle_output_destroy(struct wl_listener *l, void *p) { (void)l; (void)p; }
static void handle_output_frame(struct wl_listener *l, void *p) { (void)l; (void)p; }
static void handle_output_request_state(struct wl_listener *l, void *p);

/* UPSTREAM_OUTPUT_CONFIGURATION */

static struct cg_seat seat;
static struct cg_server server;
static struct wlr_output output;
static void setup(int width, int height, int mm_width, int mm_height) {
    server = (struct cg_server){.seat = &seat}; wl_list_init(&server.outputs);
    output = (struct wlr_output){.width = width, .height = height,
        .phys_width = mm_width, .phys_height = mm_height, .scale = 1, .name = "CONTROL-1"};
    wl_list_init(&output.modes);
    commits = layouts = finishes = cursor_loads = 0; loaded_scale = 0;
    allow_mode = allow_scale = allow_commit = true; rejected_mode = NULL;
}
static void teardown(void) { free(output.data); }
int main(void) {
    (void)wlr_output_state_set_scale; (void)wlr_output_state_finish;
    struct { const char *name; int width, height, mw, mh; float scale; } cases[] = {
        {"native1x",800,500,212,132,1}, {"small2x",1600,1000,212,132,2},
        {"roundedmm",2176,1226,288,162,2}, {"roundedmm-alt",2176,1226,287,163,2},
        {"exact192dpi",1920,1152,254,152,2}, {"retina",2880,1620,381,214,2},
        {"3x",2400,1500,212,132,3}, {"4x",3200,2000,212,132,4},
        {"loweraxis",1600,1000,212,265,1}, {"unknown",1600,1000,0,132,1},
        {"invalid",1600,1000,212,-1,1}, {"aspect1600x900",3840,2160,1600,900,1},
        {"aspect1600x1000",3840,2160,1600,1000,1}, {"aspect160x90",3840,2160,160,90,1},
        {"aspect160x100",3840,2160,160,100,1}, {"aspect16x9",3840,2160,16,9,1},
        {"aspect16x10",3840,2160,16,10,1}, {"zero-mode",0,1000,212,132,1},
    };
    unsigned checked = 0, failed = 0;
    for (size_t i = 0; i < sizeof(cases)/sizeof(cases[0]); ++i) {
        for (unsigned kind = 0; kind < 3; ++kind) {
            setup(cases[i].width,cases[i].height,cases[i].mw,cases[i].mh);
            struct wlr_output_mode preferred = {.width = cases[i].width, .height = cases[i].height};
            struct wlr_output_mode fallback = preferred;
            if (kind) {
                output.width = output.height = 1;
                wl_list_insert(&output.modes, &preferred.link);
                if (kind == 2) { wl_list_insert(&preferred.link, &fallback.link); rejected_mode = &preferred; }
            }
            handle_new_output(&server.new_output, &output); ++checked;
            if (output.scale != cases[i].scale || commits != 1 || layouts != 1 || cursor_loads != 1 || loaded_scale != cases[i].scale || finishes != 1) {
                fprintf(stderr,"%s mode%u expected%.0f got%.0f cursor%.0f commits%u layouts%u finish%u\n", cases[i].name,kind,cases[i].scale,output.scale,loaded_scale,commits,layouts,finishes); ++failed;
            }
            /* The actual native request handler must retain an explicit scale. */
            struct wlr_output_state explicit_state = {.committed = WLR_OUTPUT_STATE_SCALE, .scale = 1.5f, .enabled = true};
            struct wlr_output_event_request_state request = {&explicit_state};
            struct cg_output *cg = output.data;
            handle_output_request_state(&cg->request_state, &request);
            if (output.scale != 1.5f) { fputs("explicit later scale overwritten\n",stderr); ++failed; }
            teardown();
        }
    }
    setup(1600,1000,212,132); allow_scale = false;
    handle_new_output(&server.new_output,&output);
    if (commits || layouts || cursor_loads || finishes != 1) { fputs("rejected scale reached commit/layout/cursor load\n",stderr); ++failed; } teardown();
    setup(1600,1000,212,132); allow_mode = false;
    handle_new_output(&server.new_output,&output);
    if (commits || layouts || cursor_loads || finishes != 1) { fputs("rejected mode reached commit/layout/cursor load\n",stderr); ++failed; } teardown();
    setup(1600,1000,212,132); allow_commit = false;
    handle_new_output(&server.new_output,&output);
    if (commits != 1 || layouts || cursor_loads || finishes != 1) { fputs("failed commit still loaded cursor/added layout\n",stderr); ++failed; } teardown();
    printf("cage initial scale: %u mode cases, explicit later scales, three backend failure controls, %u failed\n",checked,failed);
    return failed != 0;
}
