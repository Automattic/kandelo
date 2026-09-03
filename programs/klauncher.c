/*
 * klauncher — the application launcher, Omarchy's Walker slot.
 *
 * A libkwl layer-shell client on the overlay layer with exclusive keyboard
 * interactivity: while it is up it owns the keyboard, so every keystroke is a
 * query character rather than input for the window underneath. Type to filter,
 * Up/Down to move, Enter to launch, ESC to dismiss. Launching goes back
 * through the compositor's kwlctl socket (`dispatch exec …`) — the launcher
 * never forks, so it needs no fork instrumentation.
 *
 * Entries come from the .conf files under /usr/share/kandelo/apps, one per app:
 *
 *     name = Terminal
 *     exec = /usr/local/bin/wlterm
 *
 * That directory is the desktop-entry registry: dropping a file in adds an
 * app, which is how a package installs itself into the launcher.
 *
 * `klauncher --menu` opens the Omarchy menu instead: a root level (Apps,
 * Theme) that descends into the app list or the installed-theme list (read
 * from `kwlctl theme`, switched with `dispatch theme`). ESC in a submenu goes
 * back to the root; ESC at the root dismisses.
 *
 * Markers on stdout for the smoke gates:
 *   KLAUNCHER_READY n=..     — mapped, with n entries loaded
 *   KLAUNCHER_LEVEL <l>      — menu level entered (root|apps|themes)
 *   KLAUNCHER_FILTER q=.. n=.. — query changed, n entries match
 *   KLAUNCHER_EXEC cmd=..    — dispatched a launch
 *   KLAUNCHER_THEME name=..  — dispatched a theme switch
 *   KLAUNCHER_EXIT           — dismissed
 */
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <kwl.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

#define KWLCTL_SOCKET_PATH "/tmp/kwlctl-0"
/* Entry + theme roots; KLAUNCHER_APPS_DIR / KANDELO_THEME_DIR override them
 * for tests. */
#define APPS_DIR           "/usr/share/kandelo/apps"
#define THEME_DIR          "/usr/share/kandelo/themes"
#define WIN_W              520
#define WIN_H              320
#define ROW_H              32
#define PROMPT_H           44
#define FONT_PX            16
#define MAX_APPS           32

/* XKB keysyms the launcher acts on. */
#define KEY_ESCAPE    0xff1b
#define KEY_RETURN    0xff0d
#define KEY_BACKSPACE 0xff08
#define KEY_UP        0xff52
#define KEY_DOWN      0xff54

static struct {
    wpk_color background, foreground, muted, accent, bar;
} palette = {
    .background = WPK_RGB(0x1b, 0x1e, 0x2b),
    .foreground = WPK_RGB(0xc8, 0xce, 0xdc),
    .muted = WPK_RGB(0x6a, 0x72, 0x8a),
    .accent = WPK_RGB(0x4f, 0x8f, 0xdf),
    .bar = WPK_RGB(0x14, 0x16, 0x20),
};

struct app {
    char name[48];
    char exec[256];
};

enum level { L_ROOT, L_APPS, L_THEMES };

static struct {
    struct app apps[MAX_APPS];
    int n_apps;
    int match[MAX_APPS];   /* indices of apps matching the query */
    int n_match;
    int selected;          /* index into match[] */
    int scroll;            /* first visible index into match[] */
    char query[64];
    int menu;              /* --menu: root level with submenus */
    enum level level;
} st;

static int parse_color(const char *s, wpk_color fallback) {
    if (*s == '#') s++;
    char *end = NULL;
    unsigned long v = strtoul(s, &end, 16);
    return end == s ? (int)fallback : (int)(0xff000000u | (v & 0xffffffu));
}

/* Trim ASCII blanks and the trailing newline in place. */
static char *trim(char *s) {
    while (*s == ' ' || *s == '\t') s++;
    char *end = s + strlen(s);
    while (end > s && (end[-1] == ' ' || end[-1] == '\t' || end[-1] == '\r' ||
                       end[-1] == '\n'))
        *--end = '\0';
    return s;
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
        char *key = trim(line), *val = trim(eq + 1);
        if (!strcmp(key, "background"))
            palette.background = parse_color(val, palette.background);
        else if (!strcmp(key, "foreground"))
            palette.foreground = parse_color(val, palette.foreground);
        else if (!strcmp(key, "muted"))
            palette.muted = parse_color(val, palette.muted);
        else if (!strcmp(key, "accent"))
            palette.accent = parse_color(val, palette.accent);
        else if (!strcmp(key, "bar"))
            palette.bar = parse_color(val, palette.bar);
    }
    fclose(f);
}

/* ---- kwlctl ------------------------------------------------------------- */

static int kwlctl_send_cmd(const char *cmd, char *out, size_t cap) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, KWLCTL_SOCKET_PATH, sizeof(addr.sun_path) - 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        close(fd);
        return -1;
    }
    char line[320];
    int n = snprintf(line, sizeof(line), "%s\n", cmd);
    if (n < 0 || n >= (int)sizeof(line)) { close(fd); return -1; }
    if (write(fd, line, (size_t)n) != n) { close(fd); return -1; }
    size_t got = 0;
    ssize_t r;
    while (out && got + 1 < cap && (r = read(fd, out + got, cap - got - 1)) > 0)
        got += (size_t)r;
    if (out) out[got] = '\0';
    close(fd);
    return 0;
}

/* Adopt the compositor's current theme, so the launcher matches the desktop
 * it opens over. */
static void sync_theme(void) {
    char buf[1024];
    if (kwlctl_send_cmd("theme", buf, sizeof(buf)) != 0) return;
    char *p = strstr(buf, "\"name\":\"");
    if (!p) return;
    char name[32];
    snprintf(name, sizeof(name), "%s", p + 8);
    char *q = strchr(name, '"');
    if (q) { *q = '\0'; theme_load(name); }
}

/* ---- entries ------------------------------------------------------------ */

static void load_apps(void) {
    const char *dir = getenv("KLAUNCHER_APPS_DIR");
    if (!dir) dir = APPS_DIR;
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d)) && st.n_apps < MAX_APPS) {
        if (e->d_name[0] == '.') continue;
        char path[512];
        snprintf(path, sizeof(path), "%s/%s", dir, e->d_name);
        FILE *f = fopen(path, "r");
        if (!f) continue;
        struct app a = {0};
        char line[256];
        while (fgets(line, sizeof(line), f)) {
            char *eq = strchr(line, '=');
            if (!eq || line[0] == '#') continue;
            *eq = '\0';
            char *key = trim(line), *val = trim(eq + 1);
            if (!strcmp(key, "name")) snprintf(a.name, sizeof(a.name), "%s", val);
            else if (!strcmp(key, "exec")) {
                /* A truncated command would launch the wrong thing, so drop
                 * the entry instead. */
                if (strlen(val) >= sizeof(a.exec)) {
                    fprintf(stderr, "klauncher: exec too long in %s\n", path);
                    a.exec[0] = '\0';
                    break;
                }
                snprintf(a.exec, sizeof(a.exec), "%s", val);
            }
        }
        fclose(f);
        if (a.name[0] && a.exec[0]) st.apps[st.n_apps++] = a;
    }
    closedir(d);

    /* Alphabetical, so the list order does not depend on readdir. */
    for (int i = 1; i < st.n_apps; i++) {
        struct app a = st.apps[i];
        int j = i;
        while (j > 0 && strcmp(st.apps[j - 1].name, a.name) > 0) {
            st.apps[j] = st.apps[j - 1];
            j--;
        }
        st.apps[j] = a;
    }
}

static void add_entry(const char *name, const char *exec) {
    if (st.n_apps >= MAX_APPS) return;
    struct app *a = &st.apps[st.n_apps++];
    snprintf(a->name, sizeof(a->name), "%s", name);
    snprintf(a->exec, sizeof(a->exec), "%s", exec);
}

static void load_root(void) {
    add_entry("Apps", "browse applications");
    add_entry("Theme", "switch theme");
}

/* The installed set, already sorted by the compositor's theme_scan; the live
 * one is tagged in the right-hand column. */
static void load_themes(void) {
    char buf[1024];
    if (kwlctl_send_cmd("theme", buf, sizeof(buf)) != 0) return;
    char live[48] = "";
    char *p = strstr(buf, "\"name\":\"");
    if (p) {
        snprintf(live, sizeof(live), "%s", p + 8);
        char *q = strchr(live, '"');
        if (q) *q = '\0';
    }
    p = strstr(buf, "\"themes\":[");
    if (!p) return;
    p += 10;
    while (*p && *p != ']') {
        if (*p != '"') { p++; continue; }
        char *q = strchr(p + 1, '"');
        if (!q) break;
        *q = '\0';
        add_entry(p + 1, strcmp(p + 1, live) == 0 ? "current" : "theme");
        p = q + 1;
    }
}

static void refilter(void);

static const char *LEVEL_NAMES[] = { "root", "apps", "themes" };

static void enter_level(enum level lvl) {
    st.level = lvl;
    st.n_apps = 0;
    st.query[0] = '\0';
    st.selected = 0;
    st.scroll = 0;
    if (lvl == L_ROOT) load_root();
    else if (lvl == L_APPS) load_apps();
    else load_themes();
    printf("KLAUNCHER_LEVEL %s\n", LEVEL_NAMES[lvl]);
    fflush(stdout);
    refilter();
}

static int ascii_lower(int c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }

/* Substring match, case-insensitive, over the name — the launcher's whole
 * filtering rule. */
static int matches(const char *name, const char *query) {
    if (!query[0]) return 1;
    for (const char *p = name; *p; p++) {
        const char *a = p, *b = query;
        while (*a && *b && ascii_lower(*a) == ascii_lower(*b)) { a++; b++; }
        if (!*b) return 1;
    }
    return 0;
}

static void refilter(void) {
    st.n_match = 0;
    for (int i = 0; i < st.n_apps; i++)
        if (matches(st.apps[i].name, st.query)) st.match[st.n_match++] = i;
    if (st.selected >= st.n_match) st.selected = st.n_match ? st.n_match - 1 : 0;
    printf("KLAUNCHER_FILTER q=%s n=%d\n", st.query, st.n_match);
    fflush(stdout);
}

/* ---- rendering ---------------------------------------------------------- */

/* Longest prefix of `text` that renders within `max_w`, with a trailing "..."
 * when it had to cut. Cuts on a UTF-8 boundary so a multi-byte glyph is never
 * split. Writes into `out` and returns it. */
static const char *fit_text(struct wpk_font *font, const char *text,
                            int max_w, char *out, size_t out_size) {
    snprintf(out, out_size, "%s", text);
    if (wpk_text_width(font, out) <= max_w) return out;

    size_t cut = strlen(out);
    while (cut > 0) {
        do { cut--; } while (cut > 0 && (text[cut] & 0xc0) == 0x80);
        if (cut + 4 > out_size) continue;
        memcpy(out, text, cut);
        memcpy(out + cut, "...", 4);
        if (wpk_text_width(font, out) <= max_w) return out;
    }
    out[0] = '\0';
    return out;
}

static void render(struct wpk_surface *s, struct wpk_font *font) {
    wpk_clear(s, palette.background);
    wpk_rect(s, 0, 0, s->w, PROMPT_H, palette.bar);
    wpk_rect(s, 0, PROMPT_H - 1, s->w, 1, palette.accent);

    int baseline = (PROMPT_H + wpk_font_ascent_px(font)) / 2 - 2;
    char prompt[80];
    snprintf(prompt, sizeof(prompt), "> %s_", st.query);
    wpk_text(s, font, 14, baseline, prompt, palette.foreground);

    int y = PROMPT_H + 4;
    int visible = (s->h - y) / ROW_H;
    if (visible < 1) visible = 1;
    int max_scroll = st.n_match - visible;
    if (max_scroll < 0) max_scroll = 0;
    if (st.scroll > max_scroll) st.scroll = max_scroll;
    if (st.scroll > st.selected) st.scroll = st.selected;
    if (st.scroll < st.selected - visible + 1)
        st.scroll = st.selected - visible + 1;
    for (int i = st.scroll; i < st.n_match && y + ROW_H <= s->h;
         i++, y += ROW_H) {
        int selected = i == st.selected;
        if (selected) wpk_rect(s, 6, y, s->w - 12, ROW_H, palette.accent);
        const struct app *a = &st.apps[st.match[i]];
        int text_y = y + (ROW_H + wpk_font_ascent_px(font)) / 2 - 2;
        wpk_text(s, font, 16, text_y, a->name,
                 selected ? palette.bar : palette.foreground);
        char exec[sizeof(a->exec) + 4];
        int name_end = 16 + wpk_text_width(font, a->name);
        fit_text(font, a->exec, s->w - 16 - name_end - 12, exec, sizeof exec);
        int ew = wpk_text_width(font, exec);
        wpk_text(s, font, s->w - ew - 16, text_y, exec,
                 selected ? palette.bar : palette.muted);
    }
    if (st.n_match == 0)
        wpk_text(s, font, 16, PROMPT_H + 28, "no matches", palette.muted);
}

int main(int argc, char **argv) {
    st.menu = argc > 1 && strcmp(argv[1], "--menu") == 0;
    enter_level(st.menu ? L_ROOT : L_APPS);
    sync_theme();

    struct kwl_layer_opts opts = {
        .layer = KWL_LAYER_OVERLAY,
        .anchor = 0,            /* unanchored: the compositor centres it */
        .w = WIN_W,
        .h = WIN_H,
        .keyboard = 1,
    };
    struct kwl_window *win = kwl_layer_create("launcher", &opts);
    if (!win) { fprintf(stderr, "klauncher: no layer shell\n"); return 1; }

    struct wpk_font *font = wpk_font_load_default(FONT_PX);
    if (!font) { fprintf(stderr, "klauncher: no font\n"); return 1; }

    render(kwl_window_surface(win), font);
    kwl_window_commit(win);
    printf("KLAUNCHER_READY n=%d\n", st.n_apps);
    fflush(stdout);

    int running = 1;
    while (running) {
        struct kwl_event ev;
        if (!kwl_dispatch(win, &ev, -1)) continue;
        int dirty = 0;
        if (ev.type == KWL_CLOSE) break;
        if (ev.type == KWL_RESIZE) dirty = 1;
        if (ev.type == KWL_KEY && ev.state == 1) {
            switch (ev.keysym) {
            case KEY_ESCAPE:
                if (st.menu && st.level != L_ROOT) {
                    enter_level(L_ROOT);
                    dirty = 1;
                } else {
                    running = 0;
                }
                break;
            case KEY_UP:
                if (st.selected > 0) st.selected--;
                dirty = 1;
                break;
            case KEY_DOWN:
                if (st.selected + 1 < st.n_match) st.selected++;
                dirty = 1;
                break;
            case KEY_BACKSPACE: {
                size_t n = strlen(st.query);
                if (n) st.query[n - 1] = '\0';
                refilter();
                dirty = 1;
                break;
            }
            case KEY_RETURN:
                if (st.n_match == 0) {
                    running = 0;
                    break;
                }
                if (st.level == L_ROOT) {
                    const struct app *a = &st.apps[st.match[st.selected]];
                    enter_level(strcmp(a->name, "Theme") == 0 ? L_THEMES
                                                              : L_APPS);
                    dirty = 1;
                } else if (st.level == L_THEMES) {
                    const struct app *a = &st.apps[st.match[st.selected]];
                    char cmd[sizeof(a->name) + 32];
                    snprintf(cmd, sizeof(cmd), "dispatch theme %s", a->name);
                    kwlctl_send_cmd(cmd, NULL, 0);
                    printf("KLAUNCHER_THEME name=%s\n", a->name);
                    fflush(stdout);
                    running = 0;
                } else {
                    const struct app *a = &st.apps[st.match[st.selected]];
                    char cmd[sizeof(a->exec) + 32];
                    snprintf(cmd, sizeof(cmd), "dispatch exec %s", a->exec);
                    kwlctl_send_cmd(cmd, NULL, 0);
                    printf("KLAUNCHER_EXEC cmd=%s\n", a->exec);
                    fflush(stdout);
                    running = 0;
                }
                break;
            }
        } else if (ev.type == KWL_TEXT && ev.utf8[0] >= ' ') {
            size_t n = strlen(st.query);
            if (n + strlen(ev.utf8) < sizeof(st.query) - 1) {
                strcat(st.query, ev.utf8);
                refilter();
                dirty = 1;
            }
        }
        if (dirty && running) {
            render(kwl_window_surface(win), font);
            kwl_window_commit(win);
        }
    }

    printf("KLAUNCHER_EXIT\n");
    fflush(stdout);
    wpk_font_destroy(font);
    kwl_window_destroy(win);
    return 0;
}
