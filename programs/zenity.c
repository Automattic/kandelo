/*
 * zenity — the file selection dialog of GNOME's zenity, on libkwl.
 *
 * Programs ask the desktop for a file by running `zenity --file-selection`
 * and reading the chosen paths from its stdout; rfd's Linux backend does
 * this when no XDG desktop portal answers. Real zenity is a thin wrapper over
 * GTK's file chooser, so it needs the whole toolkit. This program keeps its
 * command-line contract and draws the dialog with libkwl and libwpkdraw.
 *
 *   zenity --file-selection [--multiple] [--directory] [--save]
 *          [--confirm-overwrite] [--file-filter "Name | *.png *.jpg"]...
 *          [--filename PATH] [--title TEXT] [--no-markup]
 *
 * The dialog opens in the folder of --filename (or --filename itself when it
 * ends with '/'), else in the home folder ($HOME, else the password
 * database's), else in /. With --save the base name of --filename is the
 * proposed name.
 *
 * Keys: Up/Down/Page Up/Page Down/Home/End move, Enter opens a folder or
 * chooses a file, Ctrl+Enter chooses the selected folder (--directory),
 * Backspace on an empty name goes to the parent folder, Space marks an entry
 * (--multiple), Tab selects the next filter, Escape cancels. Typed text goes
 * to the name field; Enter on it opens or chooses that path.
 *
 * Exit status, as zenity: 0 with the chosen paths on stdout, separated by
 * '|'; 1 when cancelled; 255 for an unsupported option or when no window can
 * be opened.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <fnmatch.h>
#include <limits.h>
#include <pwd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <kwl.h>
#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

#define WIN_W         640
#define WIN_H         420
#define HEADER_H      64
#define FOOTER_H      52
#define ROW_H         26
#define FONT_PX       16
#define BUTTON_W      96
#define BUTTON_H      32
#define MAX_FILTERS   8
#define MAX_PATTERNS  16
#define DOUBLE_CLICK_MS 400

/* XKB keysyms the dialog acts on. */
#define KEY_ESCAPE    0xff1b
#define KEY_RETURN    0xff0d
#define KEY_KP_ENTER  0xff8d
#define KEY_BACKSPACE 0xff08
#define KEY_TAB       0xff09
#define KEY_HOME      0xff50
#define KEY_UP        0xff52
#define KEY_DOWN      0xff54
#define KEY_PAGE_UP   0xff55
#define KEY_PAGE_DOWN 0xff56
#define KEY_END       0xff57
#define KEY_SPACE     0x0020
#define KEY_CONTROL_L 0xffe3
#define KEY_CONTROL_R 0xffe4

#define BTN_LEFT      0x110

#define EXIT_CHOSEN    0
#define EXIT_CANCELLED 1
#define EXIT_ERROR     255

static const struct {
    wpk_color background, foreground, muted, accent, bar;
} palette = {
    .background = WPK_RGB(0x1b, 0x1e, 0x2b),
    .foreground = WPK_RGB(0xc8, 0xce, 0xdc),
    .muted = WPK_RGB(0x6a, 0x72, 0x8a),
    .accent = WPK_RGB(0x4f, 0x8f, 0xdf),
    .bar = WPK_RGB(0x14, 0x16, 0x20),
};

struct filter {
    char name[64];
    char *patterns[MAX_PATTERNS];
    int n_patterns;
};

struct entry {
    char *name;
    int is_dir;
    int marked;
};

static struct {
    int multiple, directory, save, confirm_overwrite;
    const char *title;
    struct filter filters[MAX_FILTERS];
    int n_filters;
    int active_filter;

    char dir[PATH_MAX];
    char name[NAME_MAX + 1];
    struct entry *entries;
    int n_entries;
    int selected;
    int scroll;
    int list_focus;           /* Enter acts on the list, not the name field */

    char replace[PATH_MAX];   /* the existing file a save asks to replace */
    int ctrl;
    int last_click_row;
    long last_click_ms;
} st = { .last_click_row = -1 };

/* ---- arguments ---------------------------------------------------------- */

static int unsupported(const char *arg) {
    fprintf(stderr, "zenity: %s is not supported\n", arg);
    return EXIT_ERROR;
}

/* "Name | *.png *.jpg", or bare patterns that also serve as the name. */
static void add_filter(char *spec) {
    if (st.n_filters >= MAX_FILTERS) return;
    struct filter *f = &st.filters[st.n_filters++];
    char *patterns = spec;
    char *bar = strchr(spec, '|');
    if (bar) {
        *bar = '\0';
        patterns = bar + 1;
    }
    snprintf(f->name, sizeof(f->name), "%s", spec);
    char *end = f->name + strlen(f->name);
    while (end > f->name && end[-1] == ' ') *--end = '\0';
    for (char *tok = strtok(patterns, " "); tok && f->n_patterns < MAX_PATTERNS;
         tok = strtok(NULL, " "))
        f->patterns[f->n_patterns++] = tok;
}

static int parse_args(int argc, char **argv, const char **filename) {
    int file_selection = 0;
    for (int i = 1; i < argc; i++) {
        char *arg = argv[i];
        char *value = strchr(arg, '=');
        if (value) *value++ = '\0';
        int takes_value = !strcmp(arg, "--file-filter") ||
                          !strcmp(arg, "--filename") || !strcmp(arg, "--title");
        if (takes_value && !value) {
            if (i + 1 >= argc) {
                fprintf(stderr, "zenity: %s needs a value\n", arg);
                return EXIT_ERROR;
            }
            value = argv[++i];
        }
        if (!strcmp(arg, "--file-selection")) file_selection = 1;
        else if (!strcmp(arg, "--multiple")) st.multiple = 1;
        else if (!strcmp(arg, "--directory")) st.directory = 1;
        else if (!strcmp(arg, "--save")) st.save = 1;
        else if (!strcmp(arg, "--confirm-overwrite")) st.confirm_overwrite = 1;
        else if (!strcmp(arg, "--no-markup")) continue;
        else if (!strcmp(arg, "--file-filter")) add_filter(value);
        else if (!strcmp(arg, "--filename")) *filename = value;
        else if (!strcmp(arg, "--title")) st.title = value;
        else return unsupported(arg);
    }
    if (!file_selection) {
        fprintf(stderr, "zenity: only --file-selection is supported\n");
        return EXIT_ERROR;
    }
    return 0;
}

/* ---- folder ------------------------------------------------------------- */

static void join(char *out, size_t cap, const char *dir, const char *name) {
    snprintf(out, cap, "%s%s%s", dir, strcmp(dir, "/") ? "/" : "", name);
}

static int is_dir(const char *path) {
    struct stat sb;
    return stat(path, &sb) == 0 && S_ISDIR(sb.st_mode);
}

static int matches_filter(const char *name) {
    if (!st.n_filters) return 1;
    const struct filter *f = &st.filters[st.active_filter];
    for (int i = 0; i < f->n_patterns; i++)
        if (fnmatch(f->patterns[i], name, FNM_CASEFOLD) == 0) return 1;
    return 0;
}

static int entry_order(const void *a, const void *b) {
    const struct entry *x = a, *y = b;
    if (!strcmp(x->name, "..")) return -1;
    if (!strcmp(y->name, "..")) return 1;
    if (x->is_dir != y->is_dir) return y->is_dir - x->is_dir;
    return strcmp(x->name, y->name);
}

static void add_entry(const char *name, int dir) {
    struct entry *grown = realloc(st.entries, (st.n_entries + 1) * sizeof *grown);
    if (!grown) return;
    st.entries = grown;
    st.entries[st.n_entries++] = (struct entry){ strdup(name), dir, 0 };
}

static void load_dir(void) {
    for (int i = 0; i < st.n_entries; i++) free(st.entries[i].name);
    st.n_entries = 0;
    st.selected = 0;
    st.scroll = 0;
    if (strcmp(st.dir, "/")) add_entry("..", 1);
    DIR *d = opendir(st.dir);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (e->d_name[0] == '.') continue;
        char path[PATH_MAX];
        join(path, sizeof(path), st.dir, e->d_name);
        int dir = is_dir(path);
        if (!dir && (st.directory || !matches_filter(e->d_name))) continue;
        add_entry(e->d_name, dir);
    }
    closedir(d);
    qsort(st.entries, st.n_entries, sizeof *st.entries, entry_order);
}

static void enter_dir(const char *path) {
    char resolved[PATH_MAX];
    if (!realpath(path, resolved) || !is_dir(resolved)) return;
    snprintf(st.dir, sizeof(st.dir), "%s", resolved);
    if (!st.save) st.name[0] = '\0';
    load_dir();
}

static const char *home_dir(void) {
    const char *home = getenv("HOME");
    if (home && *home) return home;
    struct passwd *pw = getpwuid(getuid());
    return pw ? pw->pw_dir : NULL;
}

static void start_dir(const char *filename) {
    const char *home = home_dir();
    snprintf(st.dir, sizeof(st.dir), "%s", home && is_dir(home) ? home : "/");
    if (!filename || !*filename) return;

    char folder[PATH_MAX];
    snprintf(folder, sizeof(folder), "%s", filename);
    char *slash = strrchr(folder, '/');
    if (st.save) snprintf(st.name, sizeof(st.name), "%s", slash ? slash + 1 : folder);
    if (!slash) return;
    slash[slash == folder] = '\0';
    char resolved[PATH_MAX];
    if (realpath(folder, resolved) && is_dir(resolved))
        snprintf(st.dir, sizeof(st.dir), "%s", resolved);
}

/* ---- result ------------------------------------------------------------- */

static void print_path(const char *name, int first) {
    char path[PATH_MAX];
    if (name[0] == '/') snprintf(path, sizeof(path), "%s", name);
    else join(path, sizeof(path), st.dir, name);
    printf("%s%s", first ? "" : "|", path);
}

static int choose_marked(void) {
    int n = 0;
    for (int i = 0; i < st.n_entries; i++) {
        const struct entry *e = &st.entries[i];
        if (!e->marked) continue;
        print_path(e->name, n++ == 0);
    }
    if (!n) return 0;
    printf("\n");
    fflush(stdout);
    return 1;
}

static void choose(const char *name) {
    print_path(name, 1);
    printf("\n");
    fflush(stdout);
}

/* ---- actions ------------------------------------------------------------ */

enum outcome { STAY, CHOSEN, CANCELLED };

static enum outcome save_as(const char *path) {
    struct stat sb;
    int exists = stat(path, &sb) == 0;
    if (st.confirm_overwrite && exists && strcmp(st.replace, path)) {
        snprintf(st.replace, sizeof(st.replace), "%s", path);
        return STAY;
    }
    choose(path);
    return CHOSEN;
}

/* The name field: a folder opens (or is the choice, for `pick_dir` with
 * --directory), anything else is the choice. */
static enum outcome accept_name(int pick_dir) {
    char path[PATH_MAX];
    if (st.name[0] == '/') snprintf(path, sizeof(path), "%s", st.name);
    else join(path, sizeof(path), st.dir, st.name);
    if (is_dir(path) && pick_dir && st.directory) {
        choose(path);
        return CHOSEN;
    }
    if (is_dir(path)) {
        st.name[0] = '\0';
        enter_dir(path);
        return STAY;
    }
    if (st.save) return save_as(path);
    struct stat sb;
    if (st.directory || stat(path, &sb) != 0) return STAY;
    choose(path);
    return CHOSEN;
}

/* The selected entry. `pick_dir` chooses a folder instead of opening it. */
static enum outcome activate_entry(int pick_dir) {
    if (!st.n_entries) return STAY;

    const struct entry *e = &st.entries[st.selected];
    char path[PATH_MAX];
    join(path, sizeof(path), st.dir, e->name);
    if (e->is_dir && pick_dir && st.directory) {
        if (!strcmp(e->name, "..")) choose(st.dir);
        else choose(path);
        return CHOSEN;
    }
    if (e->is_dir) {
        enter_dir(path);
        return STAY;
    }
    if (st.save) {
        snprintf(st.name, sizeof(st.name), "%s", e->name);
        return save_as(path);
    }
    choose(path);
    return CHOSEN;
}

/* Enter, Ctrl+Enter (`pick_dir`), a double click or the accept button. A save
 * takes the name field on the accept button even while the list has focus. */
static enum outcome activate(int pick_dir) {
    if (st.replace[0]) {
        choose(st.replace);
        return CHOSEN;
    }
    if (st.multiple && choose_marked()) return CHOSEN;
    if (st.name[0] && (!st.list_focus || (st.save && pick_dir)))
        return accept_name(pick_dir);
    return activate_entry(pick_dir);
}

static void move(int delta) {
    st.list_focus = 1;
    st.selected += delta;
    if (st.selected >= st.n_entries) st.selected = st.n_entries - 1;
    if (st.selected < 0) st.selected = 0;
}

static void toggle_mark(void) {
    if (!st.n_entries) return;
    struct entry *e = &st.entries[st.selected];
    if (!strcmp(e->name, "..") || e->is_dir != st.directory) return;
    e->marked = !e->marked;
}

static void next_filter(void) {
    if (st.n_filters < 2) return;
    st.active_filter = (st.active_filter + 1) % st.n_filters;
    load_dir();
}

static int visible_rows(int h) {
    int rows = (h - HEADER_H - FOOTER_H) / ROW_H;
    return rows > 1 ? rows : 1;
}

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

/* ---- rendering ---------------------------------------------------------- */

static int button_x(int w, int index) {
    return w - (index + 1) * (BUTTON_W + 12);
}

static int in_button(int w, int h, int index, int x, int y) {
    int bx = button_x(w, index), by = h - FOOTER_H + (FOOTER_H - BUTTON_H) / 2;
    return x >= bx && x < bx + BUTTON_W && y >= by && y < by + BUTTON_H;
}

static int in_filter_button(int h, int x, int y) {
    int by = h - FOOTER_H + (FOOTER_H - BUTTON_H) / 2;
    return st.n_filters && x >= 12 && x < 12 + 2 * BUTTON_W &&
           y >= by && y < by + BUTTON_H;
}

/* The tail of `text` that fits within `max_w`, behind a leading "...", so a
 * deep folder keeps the part the user is in. */
static const char *fit_tail(struct wpk_font *font, const char *text, int max_w,
                            char *out, size_t cap) {
    snprintf(out, cap, "%s", text);
    for (const char *p = text; *p && wpk_text_width(font, out) > max_w; p++) {
        if ((*p & 0xc0) == 0x80) continue;
        snprintf(out, cap, "...%s", p);
    }
    return out;
}

static void draw_button(struct wpk_surface *s, struct wpk_font *font, int x,
                        int y, int w, const char *label, int primary) {
    wpk_rect(s, x, y, w, BUTTON_H, primary ? palette.accent : palette.bar);
    int tx = x + (w - wpk_text_width(font, label)) / 2;
    int ty = y + (BUTTON_H + wpk_font_ascent_px(font)) / 2 - 2;
    wpk_text(s, font, tx, ty, label, primary ? palette.bar : palette.foreground);
}

static void render(struct wpk_surface *s, struct wpk_font *font) {
    wpk_clear(s, palette.background);
    wpk_rect(s, 0, 0, s->w, HEADER_H, palette.bar);
    wpk_rect(s, 0, HEADER_H - 1, s->w, 1, palette.accent);

    char line[PATH_MAX + 8];
    fit_tail(font, st.dir, s->w - 28, line, sizeof(line));
    wpk_text(s, font, 14, 24, line, palette.muted);
    snprintf(line, sizeof(line), "> %s_", st.name);
    wpk_text(s, font, 14, 52, line, palette.foreground);

    int rows = visible_rows(s->h);
    if (st.scroll > st.selected) st.scroll = st.selected;
    if (st.scroll < st.selected - rows + 1) st.scroll = st.selected - rows + 1;
    int y = HEADER_H + 4;
    for (int i = st.scroll; i < st.n_entries && i < st.scroll + rows;
         i++, y += ROW_H) {
        const struct entry *e = &st.entries[i];
        int selected = i == st.selected;
        if (selected) wpk_rect(s, 6, y, s->w - 12, ROW_H, palette.accent);
        snprintf(line, sizeof(line), "%s %s%s", e->marked ? "*" : " ", e->name,
                 e->is_dir && strcmp(e->name, "..") ? "/" : "");
        int ty = y + (ROW_H + wpk_font_ascent_px(font)) / 2 - 2;
        wpk_text(s, font, 12, ty, line,
                 selected ? palette.bar : e->is_dir ? palette.foreground
                                                    : palette.muted);
    }

    int fy = s->h - FOOTER_H;
    int by = fy + (FOOTER_H - BUTTON_H) / 2;
    wpk_rect(s, 0, fy, s->w, FOOTER_H, palette.bar);
    if (st.replace[0]) {
        const char *base = strrchr(st.replace, '/');
        snprintf(line, sizeof(line), "Replace %s?", base ? base + 1 : st.replace);
        int ty = fy + (FOOTER_H + wpk_font_ascent_px(font)) / 2 - 2;
        wpk_text(s, font, 14, ty, line, palette.foreground);
    } else if (st.n_filters) {
        draw_button(s, font, 12, by, 2 * BUTTON_W,
                    st.filters[st.active_filter].name, 0);
    }
    const char *accept = st.replace[0] ? "Replace" : st.save ? "Save" : "Open";
    draw_button(s, font, button_x(s->w, 0), by, BUTTON_W, accept, 1);
    draw_button(s, font, button_x(s->w, 1), by, BUTTON_W, "Cancel", 0);
}

/* ---- events ------------------------------------------------------------- */

static enum outcome on_key(const struct kwl_event *ev, int h) {
    if (ev->keysym == KEY_CONTROL_L || ev->keysym == KEY_CONTROL_R) {
        st.ctrl = ev->state == 1;
        return STAY;
    }
    if (ev->state != 1) return STAY;
    if (st.replace[0] && ev->keysym != KEY_RETURN && ev->keysym != KEY_KP_ENTER) {
        st.replace[0] = '\0';
        return ev->keysym == KEY_ESCAPE ? STAY : on_key(ev, h);
    }
    switch (ev->keysym) {
    case KEY_ESCAPE:    return CANCELLED;
    case KEY_RETURN:
    case KEY_KP_ENTER:  return activate((ev->mods & KWL_MOD_CTRL) != 0);
    case KEY_UP:        move(-1); break;
    case KEY_DOWN:      move(1); break;
    case KEY_PAGE_UP:   move(-visible_rows(h)); break;
    case KEY_PAGE_DOWN: move(visible_rows(h)); break;
    case KEY_HOME:      move(-st.n_entries); break;
    case KEY_END:       move(st.n_entries); break;
    case KEY_TAB:       next_filter(); break;
    case KEY_SPACE:
        if (st.multiple) toggle_mark();
        break;
    case KEY_BACKSPACE: {
        size_t n = strlen(st.name);
        if (n) {
            st.name[n - 1] = '\0';
            st.list_focus = 0;
            break;
        }
        char parent[PATH_MAX];
        join(parent, sizeof(parent), st.dir, "..");
        enter_dir(parent);
        break;
    }
    }
    return STAY;
}

static void on_text(const struct kwl_event *ev) {
    if ((unsigned char)ev->utf8[0] < ' ') return;
    if (st.multiple && !strcmp(ev->utf8, " ")) return;
    if (strlen(st.name) + strlen(ev->utf8) >= sizeof(st.name)) return;
    strcat(st.name, ev->utf8);
    st.list_focus = 0;
}

static enum outcome on_click(const struct kwl_event *ev, int w, int h) {
    if (ev->button != BTN_LEFT || ev->state != 1) return STAY;
    if (in_button(w, h, 1, ev->x, ev->y)) {
        if (!st.replace[0]) return CANCELLED;
        st.replace[0] = '\0';
        return STAY;
    }
    if (in_button(w, h, 0, ev->x, ev->y)) return activate(1);
    if (in_filter_button(h, ev->x, ev->y)) {
        next_filter();
        return STAY;
    }
    int row = (ev->y - HEADER_H - 4) / ROW_H;
    if (ev->y < HEADER_H + 4 || row >= visible_rows(h)) return STAY;
    int index = st.scroll + row;
    if (index >= st.n_entries) return STAY;
    st.replace[0] = '\0';
    st.selected = index;
    st.list_focus = 1;
    if (st.multiple && st.ctrl) {
        toggle_mark();
        return STAY;
    }
    long t = now_ms();
    int twice = st.last_click_row == index && t - st.last_click_ms < DOUBLE_CLICK_MS;
    st.last_click_row = twice ? -1 : index;
    st.last_click_ms = t;
    return twice ? activate(0) : STAY;
}

int main(int argc, char **argv) {
    const char *filename = NULL;
    int status = parse_args(argc, argv, &filename);
    if (status) return status;
    start_dir(filename);
    load_dir();

    const char *title = st.title ? st.title
                        : st.directory ? "Select a folder"
                        : st.save ? "Save a file" : "Select a file";
    struct kwl_window *win = kwl_dialog_create(title, WIN_W, WIN_H);
    if (!win) {
        fprintf(stderr, "zenity: cannot open a window\n");
        return EXIT_ERROR;
    }
    struct wpk_font *font = wpk_font_load_default(FONT_PX);
    if (!font) {
        fprintf(stderr, "zenity: no font\n");
        kwl_window_destroy(win);
        return EXIT_ERROR;
    }

    struct wpk_surface *s = kwl_window_surface(win);
    render(s, font);
    kwl_window_commit(win);

    enum outcome outcome = STAY;
    while (outcome == STAY) {
        struct kwl_event ev;
        if (!kwl_dispatch(win, &ev, -1)) continue;
        if (ev.type == KWL_CLOSE) outcome = CANCELLED;
        else if (ev.type == KWL_KEY) outcome = on_key(&ev, s->h);
        else if (ev.type == KWL_TEXT) on_text(&ev);
        else if (ev.type == KWL_POINTER_BUTTON) outcome = on_click(&ev, s->w, s->h);
        else if (ev.type != KWL_RESIZE) continue;
        if (outcome != STAY) break;
        render(s, font);
        kwl_window_commit(win);
    }

    wpk_font_destroy(font);
    kwl_window_destroy(win);
    return outcome == CHOSEN ? EXIT_CHOSEN : EXIT_CANCELLED;
}
