/*
 * wlclock — an animated analog clock, the "always alive" window of the
 * Wayland desktop demo. A libkwl toplevel that redraws its face ~10×/s
 * (self-paced through kwl_dispatch timeouts, throttled below the
 * compositor's frame-callback rate so an idle desktop is not recomposited
 * at full vblank speed).
 *
 * What it demonstrates: continuous wl_shm commits + wl_surface.frame
 * pacing from a second concurrent client while other windows get input —
 * i.e. the compositor really multiplexes clients.
 *
 * Markers on stdout for the smoke gates:
 *   WLCLOCK_READY — window mapped + first frame committed
 *   WLCLOCK_EXIT  — clean shutdown (close box)
 */
#include <stdio.h>
#include <time.h>

#include <kwl.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

#define WIN_W 340
#define WIN_H 360

#define CX (WIN_W / 2)
#define CY 158
#define RADIUS 130

/* sin/cos avoided on purpose: a 60-entry integer table (unit = 1/1000)
 * keeps the binary free of libm and is exact at the 60 positions a clock
 * needs. sin_q[i] = round(1000 * sin(i * 6°)), one entry per minute/second
 * tick. */
static const int sin_q[60] = {
    0,    105,  208,  309,  407,  500,  588,  669,  743,  809,
    866,  914,  951,  978,  995,  1000, 995,  978,  951,  914,
    866,  809,  743,  669,  588,  500,  407,  309,  208,  105,
    0,    -105, -208, -309, -407, -500, -588, -669, -743, -809,
    -866, -914, -951, -978, -995, -1000,-995, -978, -951, -914,
    -866, -809, -743, -669, -588, -500, -407, -309, -208, -105,
};
static int qsin(int pos60) { return sin_q[((pos60 % 60) + 60) % 60]; }
static int qcos(int pos60) { return sin_q[(((pos60 + 15) % 60) + 60) % 60]; }

/* A thick line from the centre outward: one anti-aliased capsule along
 * the hand's direction. The sin table stays integer; only the final
 * endpoint is computed in float (no libm — wpk_line_aa uses the native
 * wasm f32.sqrt). */
static void draw_hand(struct wpk_surface *s, int pos60, int len, int thick,
                      wpk_color color) {
    float dx = qsin(pos60) / 1000.0f, dy = -qcos(pos60) / 1000.0f;
    wpk_line_aa(s, CX, CY, CX + dx * len, CY + dy * len, thick, color);
}

static void draw_clock(struct wpk_surface *s, struct wpk_font *font) {
    wpk_clear(s, WPK_RGB(0x20, 0x24, 0x30));

    /* Face: ring + hour/minute ticks, one AA segment per ray. */
    for (int i = 0; i < 60; i++) {
        float dx = qsin(i) / 1000.0f, dy = -qcos(i) / 1000.0f;
        int inner = i % 5 == 0 ? RADIUS - 14 : RADIUS - 6;
        float width = i % 5 == 0 ? 3.0f : 2.0f;
        wpk_color c = i % 5 == 0 ? WPK_RGB(0xc8, 0xce, 0xdc)
                                 : WPK_RGB(0x5a, 0x62, 0x78);
        wpk_line_aa(s, CX + dx * inner, CY + dy * inner,
                    CX + dx * RADIUS, CY + dy * RADIUS, width, c);
    }

    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);

    int hour_pos = (tm.tm_hour % 12) * 5 + tm.tm_min / 12;
    draw_hand(s, hour_pos, RADIUS - 62, 6, WPK_RGB(0xe4, 0xe8, 0xf2));
    draw_hand(s, tm.tm_min, RADIUS - 34, 4, WPK_RGB(0xc0, 0xc8, 0xda));
    draw_hand(s, tm.tm_sec, RADIUS - 22, 2, WPK_RGB(0xe0, 0x6a, 0x5a));
    wpk_disc_aa(s, CX, CY, 4.5f, WPK_RGB(0xe4, 0xe8, 0xf2));

    if (font) {
        char buf[32];
        snprintf(buf, sizeof(buf), "%02d:%02d:%02d", tm.tm_hour, tm.tm_min,
                 tm.tm_sec);
        int tw = wpk_text_width(font, buf);
        wpk_text(s, font, (WIN_W - tw) / 2, WIN_H - 22, buf,
                 WPK_RGB(0x9a, 0xa4, 0xbc));
    }
}

int main(void) {
    struct kwl_window *win = kwl_window_create("wlclock", WIN_W, WIN_H);
    if (!win) { fprintf(stderr, "kwl_window_create failed\n"); return 1; }
    struct wpk_font *font = wpk_font_load_default(20);

    draw_clock(kwl_window_surface(win), font);
    kwl_window_commit(win);
    printf("WLCLOCK_READY\n");
    fflush(stdout);

    /* ~10 fps: plenty for a sweeping second hand, and it keeps an idle
     * desktop from recompositing at full flip rate. */
    struct timespec last = {0};
    clock_gettime(CLOCK_MONOTONIC, &last);
    int running = 1;
    while (running) {
        struct kwl_event ev;
        while (kwl_dispatch(win, &ev, 40)) {
            if (ev.type == KWL_CLOSE) { running = 0; break; }
        }
        struct timespec now;
        clock_gettime(CLOCK_MONOTONIC, &now);
        long ms = (now.tv_sec - last.tv_sec) * 1000 +
                  (now.tv_nsec - last.tv_nsec) / 1000000;
        if (ms >= 100) {
            last = now;
            draw_clock(kwl_window_surface(win), font);
            kwl_window_commit(win);
        }
    }

    printf("WLCLOCK_EXIT\n");
    fflush(stdout);
    if (font) wpk_font_destroy(font);
    kwl_window_destroy(win);
    return 0;
}
