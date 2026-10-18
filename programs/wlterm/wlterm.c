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
 * Under a tiling compositor the window is resized to its slot; wlterm
 * recomputes the grid from the new pixel size and re-sizes the PTY.
 *
 * Markers on stdout drive host/test/wlterm-smoke.test.ts:
 *   WLTERM_READY            — window mapped + first frame committed
 *   WLTERM_GRID "<needle>"  — <needle> is now visible in the cell grid
 *   WLTERM_RESIZE cols=.. rows=.. — the compositor dictated a new size
 *   WLTERM_EXIT code=<n>    — shell exited, clean shutdown
 *   WLTERM_EXIT signal=<n>  — shell died on a signal
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdint.h>
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

/* Keyboard input not yet accepted by the PTY. The master is non-blocking,
 * so a write can take part of it or none (EAGAIN) when the shell is not
 * reading -- a paste, or key repeat while a command runs. What the PTY does
 * not take waits here for POLLOUT instead of being discarded. The buffer
 * grows rather than applying backpressure: holding back Wayland events to
 * bound it would also hold back a close request, and what it holds is only
 * what the user typed. */
static char *g_input;
static size_t g_input_len, g_input_cap;
/* Longest sequence vt100_input_key emits into its 8-byte buffer. */
#define KEY_SEQ_MAX 8
/* PTY output consumed per loop iteration before Wayland events and input
 * get a turn again, so a flood (`yes`) cannot starve them. */
#define OUTPUT_BUDGET (64 * 1024)

/* Append one key's bytes to the pending input. */
static void queue_key(uint32_t keysym, uint32_t mods) {
    if (g_input_cap - g_input_len < KEY_SEQ_MAX) {
        size_t cap = g_input_cap ? g_input_cap * 2 : 4096;
        char *p = realloc(g_input, cap);
        if (!p) {
            /* Out of memory: nowhere to keep the key. Say so rather than
             * dropping it silently. */
            fprintf(stderr, "wlterm: out of memory; keystroke lost\n");
            return;
        }
        g_input = p;
        g_input_cap = cap;
    }
    g_input_len += vt100_input_key(keysym, mods, g_input + g_input_len,
                                   KEY_SEQ_MAX);
}

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
         * terminal has no business preferring one shell binary over it.
         *
         * The inherited TERM describes the launcher's terminal, not this one:
         * curses apps (vim, nethack, nano) must see the type this terminal
         * actually implements. */
        setenv("TERM", "vt100", 1);
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
        struct pollfd pfds[2] = {
            { .fd = display_fd, .events = POLLIN },
            { .fd = master,
              .events = POLLIN | (g_input_len > 0 ? POLLOUT : 0) },
        };
        /* Events libkwl already holds do not wake the display fd. */
        int pr = poll(pfds, 2, kwl_pending(win) ? 0 : 1000);
        if (pr < 0) {
            if (errno == EINTR) continue;
            perror("poll");
            break;
        }

        if (pfds[1].revents & POLLOUT) flush_input(master);

        /* Drain pending Wayland events; keys → pending input → PTY. */
        struct kwl_event ev;
        while (kwl_dispatch(win, &ev, 0)) {
            if (ev.type == KWL_KEY && ev.state == 1) {
                queue_key(ev.keysym, ev.mods);
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
                }
                /* Commit even when the grid kept its size: the resize
                 * rebuilt both buffers, so the compositor holds no buffer
                 * for this surface until the next commit — a tile that
                 * shifts by less than a cell (a theme's gap change) would
                 * otherwise leave the window invisible until the shell
                 * prints again. */
                vt100_mark_dirty_all(term);
                vt100_render(term, s, font, 0, 0);
                kwl_window_commit(win);
                printf("WLTERM_RESIZE cols=%d rows=%d\n", cols, rows);
                fflush(stdout);
            }
        }
        flush_input(master);

        /* PTY output → terminal grid. */
        int dirty = 0;
        if (pfds[1].revents & POLLIN) {
            char buf[4096];
            size_t budget = OUTPUT_BUDGET;
            while (budget > 0) {
                ssize_t r = read(master, buf, sizeof buf);
                if (r > 0) {
                    vt100_feed(term, buf, (size_t)r);
                    dirty = 1;
                    budget = (size_t)r < budget ? budget - (size_t)r : 0;
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

    /* Tear the surface down FIRST so the compositor removes and retiles the
     * pane immediately — otherwise a window-close (killactive) request would
     * leave the tile on screen until the shell reap below returns. */
    kwl_window_destroy(win);

    /* Reap the shell. The loop may have ended on a window-close request
     * (KWL_CLOSE) with the shell still running: closing the pty master is
     * meant to hang up the slave's foreground group, but we also SIGHUP the
     * child explicitly so the pane closes even when that hangup doesn't
     * propagate — a wedged shell must not keep waitpid (and the window)
     * blocked forever. SIGHUP on an already-exited pid is a harmless ESRCH. */
    close(master);
    int status = 0;
    if (pid > 0) {
        kill(pid, SIGHUP);
        waitpid(pid, &status, 0);
    }
    /* WEXITSTATUS is undefined unless WIFEXITED, so a signal death cannot be
     * reported through code=. */
    if (WIFSIGNALED(status)) {
        printf("WLTERM_EXIT signal=%d\n", WTERMSIG(status));
    } else {
        printf("WLTERM_EXIT code=%d\n", WIFEXITED(status) ? WEXITSTATUS(status) : 0);
    }
    fflush(stdout);

    free(g_input);
    vt100_destroy(term);
    wpk_font_destroy(font);
    return 0;
}
