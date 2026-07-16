/*
 * wlterm — a real terminal emulator: a libkwl window + the vt100 core +
 * a forkpty()'d shell. Milestone D′ (PR7 Phase 3).
 *
 *   - kwl_window_create() maps a CSD toplevel against wlcompositor and
 *     gives us a wpk_surface back buffer to draw into.
 *   - forkpty() spawns a child on a PTY and execs a shell (default "dash",
 *     or argv[1..] if given); the parent holds the master fd.
 *   - the main loop poll()s { kwl_display_fd(win), pty_master }:
 *       * Wayland key events → vt100_input_key() → write(master) → shell;
 *       * PTY output → vt100_feed() → re-render → kwl_window_commit().
 *   - the shell exiting (master EOF/HUP) or the window closing ends the loop.
 *
 * forkpty() forks, so this binary MUST be run through
 * scripts/run-wasm-fork-instrument.sh at build time (see build-programs.sh).
 *
 * Under a tiling compositor the window is resized to its slot; wlterm
 * recomputes the grid from the new pixel size and re-sizes the PTY.
 *
 * Markers on stdout drive host/test/wlterm-smoke.test.ts:
 *   WLTERM_READY            — window mapped + first frame committed
 *   WLTERM_GRID "<needle>"  — <needle> is now visible in the cell grid
 *   WLTERM_RESIZE cols=.. rows=.. — the compositor dictated a new size
 *   WLTERM_EXIT code=<n>    — shell exited, clean shutdown
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>

#include <kwl.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

#include "vt100.h"

#define WIN_W 960
#define WIN_H 540
#define FONT_PX 16

/* A grid needle the test asks wlterm to watch for and report once seen. */
static const char *g_watch[8];
static int g_watch_seen[8];
static int g_watch_n;

static void watch_add(const char *needle) {
    if (g_watch_n < 8) {
        g_watch[g_watch_n] = needle;
        g_watch_seen[g_watch_n] = 0;
        g_watch_n++;
    }
}

/* Report any newly-visible watched needles after a render. */
static void watch_report(struct vt100 *t) {
    for (int i = 0; i < g_watch_n; i++) {
        if (!g_watch_seen[i] && vt100_contains(t, g_watch[i])) {
            g_watch_seen[i] = 1;
            printf("WLTERM_GRID \"%s\"\n", g_watch[i]);
            fflush(stdout);
        }
    }
}

int main(int argc, char **argv) {
    /* A closed shell peer must not kill us via SIGPIPE. */
    signal(SIGPIPE, SIG_IGN);

    /* Optional --watch <needle> pairs consumed before the shell argv. */
    int ai = 1;
    while (ai + 1 < argc && strcmp(argv[ai], "--watch") == 0) {
        watch_add(argv[ai + 1]);
        ai += 2;
    }

    struct kwl_window *win = kwl_window_create("wlterm", WIN_W, WIN_H);
    if (!win) { fprintf(stderr, "kwl_window_create failed\n"); return 1; }

    struct wpk_font *font = wpk_font_load_default(FONT_PX);
    if (!font) { fprintf(stderr, "font load failed\n"); return 1; }

    int cell_w = wpk_text_width(font, "M");
    int cell_h = wpk_font_height_px(font);
    if (cell_w <= 0) cell_w = 1;
    if (cell_h <= 0) cell_h = 1;
    int cols = WIN_W / cell_w;
    int rows = WIN_H / cell_h;

    struct vt100 *term = vt100_create(cols, rows);
    if (!term) { fprintf(stderr, "vt100_create failed\n"); return 1; }

    /* forkpty the shell. Child stdio is the slave PTY; we keep the master. */
    struct winsize ws = {
        .ws_row = (unsigned short)rows,
        .ws_col = (unsigned short)cols,
        .ws_xpixel = WIN_W,
        .ws_ypixel = WIN_H,
    };
    int master = -1;
    pid_t pid = forkpty(&master, NULL, NULL, &ws);
    if (pid < 0) { perror("forkpty"); return 1; }
    if (pid == 0) {
        /* Child: exec argv[ai..], defaulting to an interactive dash. */
        if (ai < argc) {
            execvp(argv[ai], &argv[ai]);
        } else {
            char *sh[] = {"dash", NULL};
            execvp(sh[0], sh);
        }
        perror("execvp");
        _exit(127);
    }

    /* Master is non-blocking so poll drives all reads. */
    int fl = fcntl(master, F_GETFL, 0);
    if (fl >= 0) fcntl(master, F_SETFL, fl | O_NONBLOCK);

    struct wpk_surface *s = kwl_window_surface(win);
    /* Full first render maps the window and shows the (empty) grid. Every
     * frame re-renders the whole grid because libkwl double-buffers — each
     * back buffer would otherwise carry the frame-before-last's pixels. */
    vt100_mark_dirty_all(term);
    vt100_render(term, s, font, 0, 0);
    kwl_window_commit(win);
    printf("WLTERM_READY\n");
    fflush(stdout);

    int display_fd = kwl_display_fd(win);
    int running = 1;

    while (running) {
        struct pollfd pfds[2] = {
            { .fd = display_fd, .events = POLLIN },
            { .fd = master,     .events = POLLIN },
        };
        int pr = poll(pfds, 2, 1000);
        if (pr < 0) {
            if (errno == EINTR) continue;
            perror("poll");
            break;
        }

        /* Drain all pending Wayland events; translate keys → PTY. */
        struct kwl_event ev;
        while (kwl_dispatch(win, &ev, 0)) {
            if (ev.type == KWL_KEY && ev.state == 1) {
                char buf[8];
                size_t n = vt100_input_key(ev.keysym, ev.mods, buf, sizeof buf);
                if (n > 0) {
                    ssize_t w = write(master, buf, n);
                    (void)w;  /* EPIPE handled via the master EOF path below */
                }
            } else if (ev.type == KWL_CLOSE) {
                running = 0;
            } else if (ev.type == KWL_RESIZE) {
                /* Re-derive the grid from the new pixel size and tell the PTY,
                 * so the shell reflows to the tile. */
                int ncols = ev.x / cell_w, nrows = ev.y / cell_h;
                if (ncols < 4) ncols = 4;
                if (nrows < 4) nrows = 4;
                if (vt100_resize(term, ncols, nrows)) {
                    cols = ncols;
                    rows = nrows;
                    struct winsize nws = {
                        .ws_row = (unsigned short)rows,
                        .ws_col = (unsigned short)cols,
                        .ws_xpixel = (unsigned short)ev.x,
                        .ws_ypixel = (unsigned short)ev.y,
                    };
                    ioctl(master, TIOCSWINSZ, &nws);
                    if (pid > 0) kill(pid, SIGWINCH);
                    vt100_render(term, s, font, 0, 0);
                    kwl_window_commit(win);
                    printf("WLTERM_RESIZE cols=%d rows=%d\n", cols, rows);
                    fflush(stdout);
                }
            }
        }

        /* PTY output → terminal grid. */
        int dirty = 0;
        if (pfds[1].revents & POLLIN) {
            char buf[4096];
            for (;;) {
                ssize_t r = read(master, buf, sizeof buf);
                if (r > 0) {
                    vt100_feed(term, buf, (size_t)r);
                    dirty = 1;
                    if (r < (ssize_t)sizeof buf) break;
                } else if (r == 0) {
                    running = 0;  /* shell closed the PTY */
                    break;
                } else {
                    if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                    running = 0;  /* EIO on a hung-up master */
                    break;
                }
            }
        } else if (pfds[1].revents & (POLLHUP | POLLERR)) {
            running = 0;
        }

        if (dirty) {
            vt100_mark_dirty_all(term);
            vt100_render(term, s, font, 0, 0);
            kwl_window_commit(win);
            watch_report(term);
        }
    }

    /* Reap the shell. */
    close(master);
    int status = 0;
    if (pid > 0) waitpid(pid, &status, 0);
    int exit_code = WIFEXITED(status) ? WEXITSTATUS(status) : 0;

    printf("WLTERM_EXIT code=%d\n", exit_code);
    fflush(stdout);

    vt100_destroy(term);
    wpk_font_destroy(font);
    kwl_window_destroy(win);
    return 0;
}
