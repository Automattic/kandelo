/*
 * kwldemo — the PR7 Phase-2 gate for libkwl (examples/libs/libkwl).
 *
 * A minimal toolkit client: one libkwl window with a full-window button
 * drawn via libwpkdraw, driven against the wlcompositor server (same
 * two-process harness as the PR6 wlclient-test). It proves the toolkit
 * end-to-end — connect + map + composite + input:
 *
 *   1. kwl_window_create() connects, binds globals, maps a 320x240 CSD
 *      toplevel, and allocates its double-buffered wl_shm back buffer.
 *   2. clear the buffer to a non-black background + draw a button rect and
 *      label, kwl_window_commit(), and wait for KWL_FRAME (the compositor
 *      flipped our pixels — its COMPOSITE_SAMPLE at (10,10) is now our bg).
 *      Print KWLDEMO_READY to tell the test to inject input.
 *   3. a host-injected pointer button lands inside the button rect (the
 *      cursor enters at screen centre = window centre) → ON_CLICK.
 *   4. a host-injected key A → KWL_TEXT "a" → GOT_TEXT.
 *   5. once both arrived: KWLDEMO_OK, disconnect, exit 0.
 *
 * The window size equals the test's input-canvas size so the compositor's
 * unclipped cursor centre falls inside the button (see the plan's Phase-2
 * watch-items).
 */
#include <stdio.h>
#include <string.h>

#include <kwl.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

#define WIN_W 320
#define WIN_H 240

/* Full-window button inset by an 8px border. */
#define BTN_X 8
#define BTN_Y 8
#define BTN_W (WIN_W - 16)
#define BTN_H (WIN_H - 16)

static int in_button(int x, int y) {
    return x >= BTN_X && x < BTN_X + BTN_W &&
           y >= BTN_Y && y < BTN_Y + BTN_H;
}

int main(void) {
    struct kwl_window *win = kwl_window_create("kwldemo", WIN_W, WIN_H);
    if (!win) {
        fprintf(stderr, "kwl_window_create failed\n");
        return 1;
    }

    /* Draw the initial frame: a non-black background (so the compositor's
     * one-shot COMPOSITE_SAMPLE is visibly our pixels), a button rect, and
     * a label. */
    struct wpk_surface *s = kwl_window_surface(win);
    wpk_clear(s, WPK_RGB(30, 30, 40));
    wpk_rect(s, BTN_X, BTN_Y, BTN_W, BTN_H, WPK_RGB(70, 90, 160));

    struct wpk_font *font = wpk_font_load_default(16);
    if (font) {
        int baseline = BTN_Y + BTN_H / 2 + wpk_font_ascent_px(font) / 2;
        wpk_text(s, font, BTN_X + 16, baseline, "Click me", WPK_RGB(240, 240, 240));
    }

    kwl_window_commit(win);

    /* Wait for the compositor to present the first frame. */
    struct kwl_event ev;
    int presented = 0;
    while (!presented) {
        if (kwl_dispatch(win, &ev, -1) && ev.type == KWL_FRAME)
            presented = 1;
    }
    printf("KWLDEMO_READY\n");
    fflush(stdout);

    /* Now pump input until we have seen both a click on the button and a
     * text character. */
    int clicked = 0, typed = 0;
    while (!(clicked && typed)) {
        if (!kwl_dispatch(win, &ev, -1)) continue;
        switch (ev.type) {
        case KWL_POINTER_BUTTON:
            if (ev.state == 1 && in_button(ev.x, ev.y)) {
                clicked = 1;
                printf("ON_CLICK x=%d y=%d button=%u\n", ev.x, ev.y, ev.button);
                fflush(stdout);
            }
            break;
        case KWL_TEXT:
            typed = 1;
            printf("GOT_TEXT \"%s\"\n", ev.utf8);
            fflush(stdout);
            break;
        case KWL_CLOSE:
            fprintf(stderr, "window closed before input\n");
            if (font) wpk_font_destroy(font);
            kwl_window_destroy(win);
            return 1;
        default:
            break;
        }
    }

    printf("KWLDEMO_OK\n");
    fflush(stdout);

    if (font) wpk_font_destroy(font);
    kwl_window_destroy(win);
    return 0;
}
