/*
 * kbar — the desktop status bar, Omarchy's Waybar slot.
 *
 * A libkwl layer-shell client anchored across the top of the output with an
 * exclusive zone, so the compositor shrinks the tiling area under it and no
 * window is ever covered. It renders three Waybar-shaped modules:
 *
 *   left   workspace pills 1..N, the occupied ones filled, the active one
 *          in the theme's accent
 *   centre the focused window's app id
 *   right  the kernel's monotonic uptime and a HH:MM:SS clock (the kernel
 *          exposes no /proc/meminfo, so there is no memory module — real
 *          stats or none)
 *
 * State comes from the compositor's kwlctl socket — the same feed Waybar's
 * hyprland modules consume from hyprctl: one `workspaces` / `activewindow` /
 * `theme` query at startup, then the `--listen` event stream (`workspace>>N`,
 * `activewindow>>class,title`, `theme>>name`). The bar polls that socket
 * alongside the Wayland fd, so it repaints on an event immediately and
 * otherwise once a second for the clock.
 *
 * Markers on stdout for the smoke gates:
 *   KBAR_READY w=.. h=..   — layer surface mapped + first frame committed
 *   KBAR_WORKSPACE n=..    — active workspace changed
 *   KBAR_FOCUS app=..      — focused window changed
 *   KBAR_THEME name=..     — palette reloaded
 *   KBAR_EXIT              — clean shutdown
 */
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

#include <kwl.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

#define KWLCTL_SOCKET_PATH "/tmp/kwlctl-0"
/* Theme root; KANDELO_THEME_DIR overrides it for tests. */
#define THEME_DIR          "/usr/share/kandelo/themes"
#define BAR_H              30
#define N_WORKSPACES       9
#define PILL_W             26
#define PILL_GAP           4
#define FONT_PX            14

/* The palette, read from the live theme's theme.conf. The defaults match the
 * compositor's unthemed look, so kbar renders sanely with no theme installed. */
static struct {
    wpk_color bar, foreground, muted, accent, occupied;
} palette = {
    .bar = WPK_RGB(0x16, 0x18, 0x22),
    .foreground = WPK_RGB(0xc8, 0xce, 0xdc),
    .muted = WPK_RGB(0x6a, 0x72, 0x8a),
    .accent = WPK_RGB(0x4f, 0x8f, 0xdf),
    .occupied = WPK_RGB(0x2a, 0x31, 0x44),
};

/* What the bar draws: which workspaces exist, which is active, what has focus. */
static struct {
    int active_ws;
    int occupied[N_WORKSPACES + 1];
    char focus[64];
} st = { .active_ws = 1 };

static int parse_color(const char *s, wpk_color fallback) {
    if (*s == '#') s++;
    char *end = NULL;
    unsigned long v = strtoul(s, &end, 16);
    return end == s ? (int)fallback : (int)(0xff000000u | (v & 0xffffffu));
}

/* Load the named theme's client-side colors. Unknown keys (the compositor's
 * border/gap entries) are skipped — one file serves both sides. */
static void theme_load(const char *name) {
    const char *root = getenv("KANDELO_THEME_DIR");
    char path[256];
    snprintf(path, sizeof(path), "%s/%s/theme.conf", root ? root : THEME_DIR,
             name);
    FILE *f = fopen(path, "r");
    if (!f) return;
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        char *eq = strchr(line, '=');
        if (!eq || line[0] == '#') continue;
        *eq = '\0';
        char *key = line, *val = eq + 1;
        while (*key == ' ' || *key == '\t') key++;
        char *ke = key + strlen(key);
        while (ke > key && (ke[-1] == ' ' || ke[-1] == '\t')) *--ke = '\0';
        while (*val == ' ' || *val == '\t') val++;
        char *ve = val + strlen(val);
        while (ve > val && (ve[-1] == '\n' || ve[-1] == '\r' || ve[-1] == ' '))
            *--ve = '\0';
        if (!strcmp(key, "bar")) palette.bar = parse_color(val, palette.bar);
        else if (!strcmp(key, "foreground"))
            palette.foreground = parse_color(val, palette.foreground);
        else if (!strcmp(key, "muted"))
            palette.muted = parse_color(val, palette.muted);
        else if (!strcmp(key, "accent"))
            palette.accent = parse_color(val, palette.accent);
        else if (!strcmp(key, "occupied"))
            palette.occupied = parse_color(val, palette.occupied);
    }
    fclose(f);
    printf("KBAR_THEME name=%s\n", name);
    fflush(stdout);
}

/* ---- kwlctl feed -------------------------------------------------------- */

static int kwlctl_connect(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, KWLCTL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    /* The compositor may still be binding its control socket. */
    for (int i = 0; i < 200; i++) {
        if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0) return fd;
        usleep(10000);
    }
    close(fd);
    return -1;
}

/* One request/reply round trip on a throwaway connection (the --listen socket
 * stays open for events, so queries cannot share it). */
static int kwlctl_query(const char *cmd, char *out, size_t cap) {
    int fd = kwlctl_connect();
    if (fd < 0) return -1;
    char line[64];
    int n = snprintf(line, sizeof(line), "%s\n", cmd);
    if (write(fd, line, (size_t)n) != n) { close(fd); return -1; }
    size_t got = 0;
    ssize_t r;
    while (got + 1 < cap && (r = read(fd, out + got, cap - got - 1)) > 0)
        got += (size_t)r;
    out[got] = '\0';
    close(fd);
    return (int)got;
}

/* Pull the current state so a bar started after the desktop still shows it. */
static void sync_state(void) {
    char buf[4096];
    if (kwlctl_query("theme", buf, sizeof(buf)) > 0) {
        char *p = strstr(buf, "\"name\":\"");
        if (p) {
            char name[32];
            snprintf(name, sizeof(name), "%s", p + 8);
            char *q = strchr(name, '"');
            if (q) { *q = '\0'; theme_load(name); }
        }
    }
    if (kwlctl_query("workspaces", buf, sizeof(buf)) > 0) {
        /* [{"id":1,"windows":2,"active":true}, …] — walk the ids in order. */
        for (char *p = strstr(buf, "\"id\":"); p; p = strstr(p, "\"id\":")) {
            int id = atoi(p + 5);
            char *w = strstr(p, "\"windows\":");
            char *a = strstr(p, "\"active\":");
            if (id >= 1 && id <= N_WORKSPACES) {
                if (w) st.occupied[id] = atoi(w + 10) > 0;
                if (a && !strncmp(a + 9, "true", 4)) st.active_ws = id;
            }
            p += 5;
        }
    }
    if (kwlctl_query("activewindow", buf, sizeof(buf)) > 0) {
        char *p = strstr(buf, "\"class\":\"");
        if (p) {
            snprintf(st.focus, sizeof(st.focus), "%s", p + 9);
            char *q = strchr(st.focus, '"');
            if (q) *q = '\0';
        }
    }
}

/* Apply one `event>>data` line from the compositor's socket2-shaped stream.
 * Returns 1 when the bar must repaint. */
static int apply_event(char *line) {
    char *sep = strstr(line, ">>");
    if (!sep) return 0;
    *sep = '\0';
    char *data = sep + 2;
    if (!strcmp(line, "workspace")) {
        st.active_ws = atoi(data);
        st.occupied[st.active_ws] = 1;
        printf("KBAR_WORKSPACE n=%d\n", st.active_ws);
        fflush(stdout);
        /* Window counts changed with it; re-read rather than track them. */
        sync_state();
        return 1;
    }
    if (!strcmp(line, "activewindow")) {
        char *comma = strchr(data, ',');
        if (comma) *comma = '\0';
        snprintf(st.focus, sizeof(st.focus), "%s", data);
        if (st.focus[0]) st.occupied[st.active_ws] = 1;
        printf("KBAR_FOCUS app=%s\n", st.focus);
        fflush(stdout);
        return 1;
    }
    if (!strcmp(line, "theme")) {
        theme_load(data);
        return 1;
    }
    return 0;
}

/* ---- rendering ---------------------------------------------------------- */

static void render(struct wpk_surface *s, struct wpk_font *font) {
    wpk_clear(s, palette.bar);

    int x = 8;
    for (int ws = 1; ws <= N_WORKSPACES; ws++) {
        int active = ws == st.active_ws;
        if (!active && !st.occupied[ws]) continue;
        wpk_rect(s, x, 5, PILL_W, s->h - 10,
                 active ? palette.accent : palette.occupied);
        char label[4];
        snprintf(label, sizeof(label), "%d", ws);
        int tw = wpk_text_width(font, label);
        wpk_text(s, font, x + (PILL_W - tw) / 2,
                 (s->h + wpk_font_ascent_px(font)) / 2 - 1, label,
                 active ? palette.bar : palette.foreground);
        x += PILL_W + PILL_GAP;
    }

    int baseline = (s->h + wpk_font_ascent_px(font)) / 2 - 1;
    if (st.focus[0]) {
        int tw = wpk_text_width(font, st.focus);
        wpk_text(s, font, (s->w - tw) / 2, baseline, st.focus,
                 palette.foreground);
    }

    time_t now = time(NULL);
    struct tm tm;
    localtime_r(&now, &tm);
    char clock[16];
    snprintf(clock, sizeof(clock), "%02d:%02d:%02d", tm.tm_hour, tm.tm_min,
             tm.tm_sec);
    int cw = wpk_text_width(font, clock);
    wpk_text(s, font, s->w - cw - 12, baseline, clock, palette.foreground);

    struct timespec up;
    clock_gettime(CLOCK_MONOTONIC, &up);
    char uptime[24];
    snprintf(uptime, sizeof(uptime), "up %ld:%02ld",
             (long)(up.tv_sec / 3600), (long)(up.tv_sec / 60 % 60));
    int uw = wpk_text_width(font, uptime);
    wpk_text(s, font, s->w - cw - uw - 32, baseline, uptime, palette.muted);
}

int main(void) {
    struct kwl_layer_opts opts = {
        .layer = KWL_LAYER_TOP,
        .anchor = KWL_ANCHOR_TOP | KWL_ANCHOR_LEFT | KWL_ANCHOR_RIGHT,
        .w = 0,                 /* stretch across the output */
        .h = BAR_H,
        .exclusive_zone = BAR_H,
    };
    struct kwl_window *win = kwl_layer_create("bar", &opts);
    if (!win) { fprintf(stderr, "kbar: no layer shell\n"); return 1; }

    struct wpk_font *font = wpk_font_load_default(FONT_PX);
    if (!font) { fprintf(stderr, "kbar: no font\n"); return 1; }

    sync_state();
    struct wpk_surface *surf = kwl_window_surface(win);
    render(surf, font);
    kwl_window_commit(win);
    printf("KBAR_READY w=%d h=%d\n", surf->w, surf->h);
    fflush(stdout);

    int ctl = kwlctl_connect();
    if (ctl >= 0 && write(ctl, "--listen\n", 9) != 9) {
        close(ctl);
        ctl = -1;
    }

    int running = 1;
    while (running) {
        /* Wake on a compositor event or once a second for the clock. */
        struct pollfd pfd[2] = {
            { .fd = kwl_display_fd(win), .events = POLLIN },
            { .fd = ctl, .events = POLLIN },
        };
        poll(pfd, ctl >= 0 ? 2 : 1, 1000);

        int dirty = 1;   /* the clock alone is reason enough to repaint */
        struct kwl_event ev;
        while (kwl_dispatch(win, &ev, 0)) {
            if (ev.type == KWL_CLOSE) running = 0;
            if (ev.type == KWL_RESIZE) dirty = 1;
        }
        if (ctl >= 0 && (pfd[1].revents & (POLLIN | POLLHUP))) {
            char buf[1024];
            ssize_t r = read(ctl, buf, sizeof(buf) - 1);
            if (r <= 0) { close(ctl); ctl = -1; running = 0; }
            else {
                buf[r] = '\0';
                for (char *line = strtok(buf, "\n"); line;
                     line = strtok(NULL, "\n"))
                    dirty |= apply_event(line);
            }
        }
        if (dirty && running) {
            render(kwl_window_surface(win), font);
            kwl_window_commit(win);
        }
    }

    printf("KBAR_EXIT\n");
    fflush(stdout);
    if (ctl >= 0) close(ctl);
    wpk_font_destroy(font);
    kwl_window_destroy(win);
    return 0;
}
