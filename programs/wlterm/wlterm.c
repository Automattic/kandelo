/*
 * wlterm — a real terminal emulator: a libkwl window + the vt100 core +
 * a forkpty()'d shell. Milestone D′ (PR7 Phase 3).
 *
 *   - kwl_window_create() maps a CSD toplevel against wlcompositor and
 *     gives us a wpk_surface back buffer to draw into.
 *   - forkpty() spawns a child on a PTY and execs a shell (default `sh`,
 *     or argv[1..] if given); the parent holds the master fd.
 *   - the main loop poll()s { kwl_display_fd(win), pty_master }:
 *       * Wayland key events → vt100_input_key() → pending input → write(master)
 *         when the PTY can take it (POLLOUT) → shell;
 *       * PTY output → vt100_feed() → re-render → kwl_window_commit().
 *   - the shell exiting (master EOF/HUP) or the window closing ends the loop.
 *
 * forkpty() forks, so this binary MUST be run through
 * scripts/run-wasm-fork-instrument.sh at build time (see build-programs.sh).
 *
 * Markers on stdout drive host/test/wlterm-smoke.test.ts:
 *   WLTERM_READY            — window mapped + first frame committed
 *   WLTERM_GRID "<needle>"  — <needle> is now visible in the cell grid
 *   WLTERM_EXIT code=<n>    — shell exited, clean shutdown
 *   WLTERM_EXIT signal=<n>  — shell died on a signal
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include <kwl.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

#include "vt100.h"

#define WIN_W 960
#define WIN_H 540
#define FONT_PX 16

/* Keyboard input not yet accepted by the PTY. The master is non-blocking,
 * so a write can take part of it or none (EAGAIN) when the shell is not
 * reading -- a paste, or key repeat while a command runs. What the PTY does
 * not take waits here for POLLOUT instead of being discarded. */
static char g_input[4096];
static size_t g_input_len;
/* Longest sequence vt100_input_key emits into its 8-byte buffer. */
#define KEY_SEQ_MAX 8

/* Write as much pending input as the PTY accepts. */
static void flush_input(int master) {
    while (g_input_len > 0) {
        ssize_t w = write(master, g_input, g_input_len);
        if (w > 0) {
            memmove(g_input, g_input + w, g_input_len - (size_t)w);
            g_input_len -= (size_t)w;
        } else if (w < 0 && errno == EINTR) {
            continue;
        } else if (w == 0 || errno == EAGAIN || errno == EWOULDBLOCK) {
            return;   /* no room now: POLLOUT resumes the flush */
        } else {
            /* EIO: the slave side is gone. The master read path sees the
             * same hangup and ends the loop; this input has no reader. */
            g_input_len = 0;
            return;
        }
    }
}

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
        /* Child: exec argv[ai..], else `sh`.
         *
         * `sh` is the one shell name POSIX guarantees, and it is what this
         * image provides. The previous default was "dash", which this image
         * does not ship at all -- wlterm exited 127 the moment it started
         * and took the whole desktop down with it. Resolving through PATH
         * means whatever the image makes `sh` (bash here) is what runs; the
         * terminal has no business preferring one shell binary over it. */
        if (ai < argc) {
            execvp(argv[ai], &argv[ai]);
        } else {
            char *sh[] = {"sh", NULL};
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
        /* With no room for another key's bytes, stop taking Wayland events:
         * they wait, in order, in libkwl's queue and the socket until the
         * shell reads and POLLOUT frees space. */
        int input_room = g_input_len + KEY_SEQ_MAX <= sizeof g_input;
        struct pollfd pfds[2] = {
            { .fd = display_fd, .events = input_room ? POLLIN : 0 },
            { .fd = master,
              .events = POLLIN | (g_input_len > 0 ? POLLOUT : 0) },
        };
        /* Events libkwl already holds do not wake the display fd. */
        int pr = poll(pfds, 2, input_room && kwl_pending(win) ? 0 : 1000);
        if (pr < 0) {
            if (errno == EINTR) continue;
            perror("poll");
            break;
        }

        if (pfds[1].revents & POLLOUT) flush_input(master);

        /* Drain pending Wayland events while there is room; keys → PTY. */
        struct kwl_event ev;
        while (g_input_len + KEY_SEQ_MAX <= sizeof g_input
               && kwl_dispatch(win, &ev, 0)) {
            if (ev.type == KWL_KEY && ev.state == 1) {
                size_t n = vt100_input_key(ev.keysym, ev.mods,
                                           g_input + g_input_len, KEY_SEQ_MAX);
                g_input_len += n;
            } else if (ev.type == KWL_CLOSE) {
                running = 0;
            }
        }
        flush_input(master);

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
                    /* A signal is not a hangup: retry. */
                    if (errno == EINTR) continue;
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
    /* WEXITSTATUS is undefined unless WIFEXITED, so a signal death cannot be
     * reported through code=. */
    if (WIFSIGNALED(status)) {
        printf("WLTERM_EXIT signal=%d\n", WTERMSIG(status));
    } else {
        printf("WLTERM_EXIT code=%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : 0);
    }
    fflush(stdout);

    vt100_destroy(term);
    wpk_font_destroy(font);
    kwl_window_destroy(win);
    return 0;
}
