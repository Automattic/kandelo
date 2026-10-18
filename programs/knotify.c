/*
 * knotify — a transient notification toast, Omarchy's notify-send slot.
 *
 * One toast per process: `knotify <title> <body…>` maps an overlay-layer
 * surface in the top-right corner (under the bar's reserved strip), shows the
 * message for a moment, and exits — the surface teardown is the dismissal, so
 * there is no daemon and no unmap protocol. The compositor's `notify =`
 * config hook spawns it on a theme switch; anything else can spawn it too.
 *
 * Markers on stdout for the smoke gates:
 *   KNOTIFY_READY title=..  — toast mapped + first frame committed
 *   KNOTIFY_EXIT            — dismissed
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
#define TOAST_W            300
#define TOAST_H            64
#define TOAST_MARGIN       12
#define TOAST_MS           2500
#define FONT_PX            15

static struct {
    wpk_color bar, foreground, muted, accent;
} palette = {
    .bar = WPK_RGB(0x16, 0x18, 0x22),
    .foreground = WPK_RGB(0xc8, 0xce, 0xdc),
    .muted = WPK_RGB(0x6a, 0x72, 0x8a),
    .accent = WPK_RGB(0x4f, 0x8f, 0xdf),
};

static int parse_color(const char *s, wpk_color fallback) {
    if (*s == '#') s++;
    char *end = NULL;
    unsigned long v = strtoul(s, &end, 16);
    return end == s ? (int)fallback : (int)(0xff000000u | (v & 0xffffffu));
}

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
    }
    fclose(f);
}

/* Adopt the compositor's live theme, so the toast matches the desktop. */
static void sync_theme(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, KWLCTL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return;
    }
    char buf[1024] = "";
    if (write(fd, "theme\n", 6) == 6) {
        size_t got = 0;
        ssize_t r;
        while (got + 1 < sizeof(buf) &&
               (r = read(fd, buf + got, sizeof(buf) - got - 1)) > 0)
            got += (size_t)r;
        buf[got] = '\0';
    }
    close(fd);
    char *p = strstr(buf, "\"name\":\"");
    if (!p) return;
    char name[32];
    snprintf(name, sizeof(name), "%s", p + 8);
    char *q = strchr(name, '"');
    if (q) { *q = '\0'; theme_load(name); }
}

int main(int argc, char **argv) {
    const char *title = argc > 1 ? argv[1] : "Notice";
    char body[128] = "";
    for (int i = 2; i < argc; i++) {
        if (body[0]) strncat(body, " ", sizeof(body) - strlen(body) - 1);
        strncat(body, argv[i], sizeof(body) - strlen(body) - 1);
    }
    sync_theme();

    struct kwl_layer_opts opts = {
        .layer = KWL_LAYER_OVERLAY,
        .anchor = KWL_ANCHOR_TOP | KWL_ANCHOR_RIGHT,
        .w = TOAST_W,
        .h = TOAST_H,
        .margin_top = TOAST_MARGIN,
        .margin_right = TOAST_MARGIN,
    };
    struct kwl_window *win = kwl_layer_create("notify", &opts);
    if (!win) { fprintf(stderr, "knotify: no layer shell\n"); return 1; }

    struct wpk_font *font = wpk_font_load_default(FONT_PX);
    if (!font) { fprintf(stderr, "knotify: no font\n"); return 1; }

    struct wpk_surface *s = kwl_window_surface(win);
    wpk_clear(s, palette.bar);
    wpk_rect(s, 0, 0, 4, s->h, palette.accent);
    wpk_text(s, font, 16, 6 + wpk_font_ascent_px(font), title,
             palette.foreground);
    if (body[0])
        wpk_text(s, font, 16, s->h - 12, body, palette.muted);
    kwl_window_commit(win);
    printf("KNOTIFY_READY title=%s\n", title);
    fflush(stdout);

    struct timespec t0;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    int running = 1;
    while (running) {
        struct pollfd pfd = { .fd = kwl_display_fd(win), .events = POLLIN };
        poll(&pfd, 1, 100);
        struct kwl_event ev;
        while (kwl_dispatch(win, &ev, 0))
            if (ev.type == KWL_CLOSE) running = 0;
        struct timespec t;
        clock_gettime(CLOCK_MONOTONIC, &t);
        long ms = (t.tv_sec - t0.tv_sec) * 1000 +
                  (t.tv_nsec - t0.tv_nsec) / 1000000;
        if (ms >= TOAST_MS) running = 0;
    }

    printf("KNOTIFY_EXIT\n");
    fflush(stdout);
    wpk_font_destroy(font);
    kwl_window_destroy(win);
    return 0;
}
