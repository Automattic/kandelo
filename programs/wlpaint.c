/*
 * wlpaint — a small paint program for the Wayland desktop demo: a color
 * palette + clear button toolbar over a persistent canvas you draw on by
 * dragging the pointer.
 *
 * What it demonstrates: surface-local pointer routing (enter/motion/button
 * from the compositor arrive content-local through libkwl), press/drag
 * state across motion events, and damage-driven commits from a third
 * concurrent client.
 *
 * The canvas is an app-owned buffer, not the wl_shm back buffer: libkwl
 * double-buffers, so a stroke painted directly into one back buffer would
 * flicker in and out on alternate commits. Every dirty frame blits canvas +
 * toolbar into the current back buffer and commits.
 *
 * Under a tiling compositor the window is resized to fill its slot: libkwl
 * rebuilds the wl_shm buffers at the tile size and delivers KWL_RESIZE. The
 * toolbar spans the full surface width and the canvas is reallocated to the
 * new content area (preserving the overlapping painting), so wlpaint fills its
 * tile instead of drawing a fixed 640×420 island in the corner. Floating
 * clients ignore the initial configure(0,0) and never see KWL_RESIZE, so
 * /?demo=wayland keeps the exact 640×420 layout the desktop gate asserts.
 *
 * Markers on stdout for the smoke gates:
 *   WLPAINT_READY            — window mapped + first frame committed
 *   WLPAINT_RESIZE w=… h=…   — the compositor dictated a new size (tiling)
 *   WLPAINT_STROKE x=… y=…   — first stamp of each stroke (press)
 *   WLPAINT_STROKE_END       — the stroke's release arrived (drag over;
 *                              gates the pointer-grab/release routing)
 *   WLPAINT_COLOR i=…        — palette swatch selected
 *   WLPAINT_CLEAR            — clear button pressed
 *   WLPAINT_EXIT             — clean shutdown (close box)
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <linux/input-event-codes.h>

#include <kwl.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

#define WIN_W 640           /* initial requested size; a tiler overrides it */
#define WIN_H 420
#define TOOLBAR_H 36

#define SWATCH_SZ 24
#define SWATCH_X0 8
#define SWATCH_STEP 32
#define BRUSH_R 4

static const wpk_color palette[] = {
    WPK_RGB(0x20, 0x22, 0x28),   /* ink */
    WPK_RGB(0xd8, 0x4a, 0x3a),   /* red */
    WPK_RGB(0xe8, 0xa3, 0x2e),   /* amber */
    WPK_RGB(0x3f, 0x9e, 0x4d),   /* green */
    WPK_RGB(0x3a, 0x76, 0xd0),   /* blue */
    WPK_RGB(0x8a, 0x4f, 0xc9),   /* violet */
    WPK_RGB(0xf4, 0xf4, 0xf0),   /* eraser (canvas bg) */
};
#define N_COLORS ((int)(sizeof(palette) / sizeof(palette[0])))
#define CANVAS_BG WPK_RGB(0xf4, 0xf4, 0xf0)

#define CLEAR_X (SWATCH_X0 + N_COLORS * SWATCH_STEP + 12)
#define CLEAR_W 56
#define CLEAR_H 24

/* App-owned painting, canvas_w × canvas_h (the content area below the
 * toolbar). Reallocated on resize rather than fixed, so the painting fills
 * whatever tile the compositor hands us. */
static uint32_t *canvas = NULL;
static int canvas_w = 0, canvas_h = 0;
static int cur_color = 4;   /* start on blue */

static void canvas_clear(void) {
    for (int i = 0; i < canvas_w * canvas_h; i++) canvas[i] = CANVAS_BG;
}

/* (Re)allocate the canvas to w×h, preserving the overlapping top-left region
 * so an in-progress painting survives a retile. Returns 0 on success. */
static int canvas_resize(int w, int h) {
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    if (canvas && w == canvas_w && h == canvas_h) return 0;
    uint32_t *nc = malloc((size_t)w * h * sizeof(*nc));
    if (!nc) return -1;
    for (int i = 0; i < w * h; i++) nc[i] = CANVAS_BG;
    if (canvas) {
        int cw = w < canvas_w ? w : canvas_w;
        int ch = h < canvas_h ? h : canvas_h;
        for (int y = 0; y < ch; y++)
            memcpy(nc + (size_t)y * w, canvas + (size_t)y * canvas_w,
                   (size_t)cw * sizeof(*nc));
        free(canvas);
    }
    canvas = nc;
    canvas_w = w;
    canvas_h = h;
    return 0;
}

/* Stamp a filled brush disc at canvas coordinates. */
static void stamp(int x, int y) {
    for (int dy = -BRUSH_R; dy <= BRUSH_R; dy++) {
        for (int dx = -BRUSH_R; dx <= BRUSH_R; dx++) {
            if (dx * dx + dy * dy > BRUSH_R * BRUSH_R) continue;
            int px = x + dx, py = y + dy;
            if (px < 0 || px >= canvas_w || py < 0 || py >= canvas_h) continue;
            canvas[py * canvas_w + px] = palette[cur_color];
        }
    }
}

/* Stamp along the segment from (x0,y0) to (x1,y1) so fast drags leave a
 * continuous stroke. */
static void stroke(int x0, int y0, int x1, int y1) {
    int dx = x1 - x0, dy = y1 - y0;
    int steps = (dx < 0 ? -dx : dx) > (dy < 0 ? -dy : dy)
                    ? (dx < 0 ? -dx : dx)
                    : (dy < 0 ? -dy : dy);
    if (steps == 0) { stamp(x1, y1); return; }
    for (int t = 0; t <= steps; t++)
        stamp(x0 + dx * t / steps, y0 + dy * t / steps);
}

static void render(struct wpk_surface *s, struct wpk_font *font) {
    /* Toolbar spans the full surface width. */
    wpk_rect(s, 0, 0, s->w, TOOLBAR_H, WPK_RGB(0x2e, 0x33, 0x42));
    for (int i = 0; i < N_COLORS; i++) {
        int x = SWATCH_X0 + i * SWATCH_STEP;
        int y = (TOOLBAR_H - SWATCH_SZ) / 2;
        if (i == cur_color)
            wpk_rect(s, x - 3, y - 3, SWATCH_SZ + 6, SWATCH_SZ + 6,
                     WPK_RGB(0xd8, 0xdd, 0xe8));
        wpk_rect(s, x, y, SWATCH_SZ, SWATCH_SZ, palette[i]);
    }
    wpk_rect(s, CLEAR_X, (TOOLBAR_H - CLEAR_H) / 2, CLEAR_W, CLEAR_H,
             WPK_RGB(0x44, 0x4b, 0x5e));
    if (font) {
        wpk_text(s, font, CLEAR_X + 10,
                 (TOOLBAR_H + wpk_font_ascent_px(font)) / 2 - 1, "clear",
                 WPK_RGB(0xd8, 0xdd, 0xe8));
        wpk_text(s, font, CLEAR_X + CLEAR_W + 16,
                 (TOOLBAR_H + wpk_font_ascent_px(font)) / 2 - 1,
                 "drag to paint", WPK_RGB(0x8a, 0x93, 0xaa));
    }

    /* Canvas fills the area below the toolbar. Paint the background first so
     * any surface region the canvas doesn't cover (should be none while the
     * two are kept in sync) never shows stale bytes, then blit the stored
     * painting clipped to the overlap. */
    int area_h = s->h - TOOLBAR_H;
    if (area_h < 0) area_h = 0;
    wpk_rect(s, 0, TOOLBAR_H, s->w, area_h, CANVAS_BG);
    int cw = s->w < canvas_w ? s->w : canvas_w;
    int ch = area_h < canvas_h ? area_h : canvas_h;
    for (int y = 0; y < ch; y++)
        memcpy(s->pixels + (size_t)(y + TOOLBAR_H) * (s->stride / 4),
               canvas + (size_t)y * canvas_w, (size_t)cw * 4);
}

int main(void) {
    struct kwl_window *win = kwl_window_create("wlpaint", WIN_W, WIN_H);
    if (!win) { fprintf(stderr, "kwl_window_create failed\n"); return 1; }
    struct wpk_font *font = wpk_font_load_default(14);

    /* Size the canvas from the surface the compositor actually gave us: 640×420
     * floating, or the tile size a tiler dictated before the first frame. */
    struct wpk_surface *s0 = kwl_window_surface(win);
    if (canvas_resize(s0->w, s0->h - TOOLBAR_H) != 0) {
        fprintf(stderr, "canvas alloc failed\n");
        return 1;
    }
    render(s0, font);
    kwl_window_commit(win);
    printf("WLPAINT_READY\n");
    fflush(stdout);

    int running = 1, drawing = 0, dirty = 0;
    int last_x = 0, last_y = 0;
    while (running) {
        struct kwl_event ev;
        /* Block until traffic, then drain; commit once per batch. */
        int got = kwl_dispatch(win, &ev, 1000);
        while (got) {
            switch (ev.type) {
            case KWL_POINTER_BUTTON:
                if (ev.button == BTN_LEFT && ev.state == 1) {
                    if (ev.y < TOOLBAR_H) {
                        /* Toolbar click: swatch or clear. */
                        for (int i = 0; i < N_COLORS; i++) {
                            int x = SWATCH_X0 + i * SWATCH_STEP;
                            if (ev.x >= x && ev.x < x + SWATCH_SZ) {
                                cur_color = i;
                                dirty = 1;
                                printf("WLPAINT_COLOR i=%d\n", i);
                                fflush(stdout);
                            }
                        }
                        if (ev.x >= CLEAR_X && ev.x < CLEAR_X + CLEAR_W) {
                            canvas_clear();
                            dirty = 1;
                            printf("WLPAINT_CLEAR\n");
                            fflush(stdout);
                        }
                    } else {
                        drawing = 1;
                        last_x = ev.x;
                        last_y = ev.y - TOOLBAR_H;
                        stamp(last_x, last_y);
                        dirty = 1;
                        printf("WLPAINT_STROKE x=%d y=%d\n", ev.x, ev.y);
                        fflush(stdout);
                    }
                } else if (ev.button == BTN_LEFT && ev.state == 0) {
                    if (drawing) {
                        printf("WLPAINT_STROKE_END\n");
                        fflush(stdout);
                    }
                    drawing = 0;
                }
                break;
            case KWL_POINTER_MOTION:
                if (drawing && ev.y >= TOOLBAR_H) {
                    stroke(last_x, last_y, ev.x, ev.y - TOOLBAR_H);
                    last_x = ev.x;
                    last_y = ev.y - TOOLBAR_H;
                    dirty = 1;
                }
                break;
            case KWL_RESIZE:
                /* The compositor tiled us into a new slot. libkwl already
                 * rebuilt the wl_shm buffers; grow the painting to match and
                 * redraw so the toolbar + canvas fill the whole tile. */
                printf("WLPAINT_RESIZE w=%d h=%d\n", ev.x, ev.y);
                fflush(stdout);
                canvas_resize(ev.x, ev.y - TOOLBAR_H);
                dirty = 1;
                break;
            case KWL_CLOSE:
                running = 0;
                break;
            default:
                break;
            }
            got = running ? kwl_dispatch(win, &ev, 0) : 0;
        }
        if (dirty) {
            dirty = 0;
            render(kwl_window_surface(win), font);
            kwl_window_commit(win);
        }
    }

    printf("WLPAINT_EXIT\n");
    fflush(stdout);
    if (font) wpk_font_destroy(font);
    kwl_window_destroy(win);
    free(canvas);
    return 0;
}
