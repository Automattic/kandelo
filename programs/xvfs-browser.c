/*
 * xvfs-browser - a tiny X11 Kandelo VFS browser.
 *
 * This is a real X client: it connects to DISPLAY=:0 through libX11, creates
 * a top-level window, and renders file listings with normal X drawing
 * requests. File data comes from POSIX opendir/readdir/stat calls against the
 * Kandelo VFS.
 */
#include <X11/Xlib.h>
#include <X11/keysym.h>
#include <X11/Xutil.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 512
#endif

#define MAX_ENTRIES 256
#define NAME_LEN 128

typedef struct {
    char name[NAME_LEN];
    int is_dir;
    unsigned long size;
} Entry;

typedef struct {
    unsigned long bg;
    unsigned long panel;
    unsigned long bar;
    unsigned long text;
    unsigned long muted;
    unsigned long accent;
    unsigned long select;
    unsigned long line;
    unsigned long white;
    unsigned long black;
    unsigned long green;
} Palette;

static Entry entries[MAX_ENTRIES];
static int entry_count;
static int selected;
static int scroll_row;
static char cwd_path[PATH_MAX] = "/home";
static char status_line[192] = "Connecting to Kandelo VFS";

static int handle_x_io_error(Display *dpy) {
    (void)dpy;
    fprintf(stderr, "xvfs-browser: X connection closed\n");
    fflush(stderr);
    _exit(0);
}

static const uint8_t *glyph(char c) {
    static const uint8_t blank[7] = {0, 0, 0, 0, 0, 0, 0};
    static const uint8_t unk[7] = {14, 17, 1, 2, 4, 0, 4};
    static const uint8_t tbl[46][7] = {
        {14,17,19,21,25,17,14}, {4,12,4,4,4,4,14},
        {14,17,1,2,4,8,31}, {30,1,1,14,1,1,30},
        {2,6,10,18,31,2,2}, {31,16,30,1,1,17,14},
        {6,8,16,30,17,17,14}, {31,1,2,4,8,8,8},
        {14,17,17,14,17,17,14}, {14,17,17,15,1,2,12},
        {14,17,17,31,17,17,17}, {30,17,17,30,17,17,30},
        {14,17,16,16,16,17,14}, {30,17,17,17,17,17,30},
        {31,16,16,30,16,16,31}, {31,16,16,30,16,16,16},
        {14,17,16,23,17,17,15}, {17,17,17,31,17,17,17},
        {14,4,4,4,4,4,14}, {7,2,2,2,18,18,12},
        {17,18,20,24,20,18,17}, {16,16,16,16,16,16,31},
        {17,27,21,21,17,17,17}, {17,25,21,19,17,17,17},
        {14,17,17,17,17,17,14}, {30,17,17,30,16,16,16},
        {14,17,17,17,21,18,13}, {30,17,17,30,20,18,17},
        {15,16,16,14,1,1,30}, {31,4,4,4,4,4,4},
        {17,17,17,17,17,17,14}, {17,17,17,17,17,10,4},
        {17,17,17,21,21,21,10}, {17,17,10,4,10,17,17},
        {17,17,10,4,4,4,4}, {31,1,2,4,8,16,31},
        {0,0,0,0,0,0,4}, {0,0,0,31,0,0,0}, {0,0,0,0,0,12,12},
        {0,0,0,0,0,0,0}, {4,4,4,4,4,0,4}, {0,0,0,14,0,0,0},
        {1,2,4,8,16,0,0}, {0,4,0,31,0,4,0}, {10,10,31,10,31,10,10},
        {4,14,20,14,5,14,4}
    };
    if (c >= 'a' && c <= 'z') c -= 32;
    if (c >= '0' && c <= '9') return tbl[c - '0'];
    if (c >= 'A' && c <= 'Z') return tbl[10 + c - 'A'];
    if (c == '.') return tbl[36];
    if (c == '-') return tbl[37];
    if (c == ':') return tbl[38];
    if (c == ' ') return tbl[39];
    if (c == '!') return tbl[40];
    if (c == '_') return tbl[41];
    if (c == '/') return tbl[42];
    if (c == '+') return tbl[43];
    if (c == '#') return tbl[44];
    if (c == '$') return tbl[45];
    return c ? unk : blank;
}

static void set_fg(Display *dpy, GC gc, unsigned long pixel) {
    XSetForeground(dpy, gc, pixel);
}

static void fill(Display *dpy, Drawable drawable, GC gc, int x, int y, int w, int h, unsigned long pixel) {
    if (w <= 0 || h <= 0) return;
    set_fg(dpy, gc, pixel);
    XFillRectangle(dpy, drawable, gc, x, y, (unsigned)w, (unsigned)h);
}

static void frame(Display *dpy, Drawable drawable, GC gc, int x, int y, int w, int h, unsigned long pixel) {
    fill(dpy, drawable, gc, x, y, w, 1, pixel);
    fill(dpy, drawable, gc, x, y + h - 1, w, 1, pixel);
    fill(dpy, drawable, gc, x, y, 1, h, pixel);
    fill(dpy, drawable, gc, x + w - 1, y, 1, h, pixel);
}

static void draw_text(Display *dpy, Drawable drawable, GC gc, int x, int y, const char *s,
                      unsigned long pixel, int scale) {
    if (scale <= 0) scale = 1;
    set_fg(dpy, gc, pixel);
    for (; *s; s++, x += 6 * scale) {
        const uint8_t *g = glyph(*s);
        for (int yy = 0; yy < 7; yy++) {
            for (int xx = 0; xx < 5; xx++) {
                if (g[yy] & (1 << (4 - xx))) {
                    XFillRectangle(dpy, drawable, gc, x + xx * scale, y + yy * scale,
                                   (unsigned)scale, (unsigned)scale);
                }
            }
        }
    }
}

static unsigned long alloc_rgb(Display *dpy, Colormap cmap, int r, int g, int b) {
    XColor color;
    color.red = (unsigned short)(r * 257);
    color.green = (unsigned short)(g * 257);
    color.blue = (unsigned short)(b * 257);
    color.flags = DoRed | DoGreen | DoBlue;
    if (XAllocColor(dpy, cmap, &color)) return color.pixel;
    return ((unsigned long)r << 16) | ((unsigned long)g << 8) | (unsigned long)b;
}

static Palette make_palette(Display *dpy, int screen) {
    Colormap cmap = DefaultColormap(dpy, screen);
    Palette p;
    p.bg = alloc_rgb(dpy, cmap, 42, 47, 53);
    p.panel = alloc_rgb(dpy, cmap, 251, 247, 237);
    p.bar = alloc_rgb(dpy, cmap, 216, 95, 43);
    p.text = alloc_rgb(dpy, cmap, 36, 25, 15);
    p.muted = alloc_rgb(dpy, cmap, 118, 104, 79);
    p.accent = alloc_rgb(dpy, cmap, 47, 124, 143);
    p.select = alloc_rgb(dpy, cmap, 255, 220, 168);
    p.line = alloc_rgb(dpy, cmap, 187, 169, 131);
    p.white = alloc_rgb(dpy, cmap, 255, 255, 255);
    p.black = alloc_rgb(dpy, cmap, 0, 0, 0);
    p.green = alloc_rgb(dpy, cmap, 95, 143, 115);
    return p;
}

static void join_path(char *out, size_t n, const char *base, const char *name) {
    if (!strcmp(base, "/")) snprintf(out, n, "/%s", name);
    else snprintf(out, n, "%s/%s", base, name);
}

static void go_parent(void) {
    if (!strcmp(cwd_path, "/")) return;
    char *slash = strrchr(cwd_path, '/');
    if (!slash || slash == cwd_path) strcpy(cwd_path, "/");
    else *slash = 0;
}

static void set_cwd_path(const char *path) {
    if (!path || !*path) path = "/";
    snprintf(cwd_path, sizeof(cwd_path), "%s", path);
}

static int cmp_entries(const void *a, const void *b) {
    const Entry *ea = (const Entry *)a;
    const Entry *eb = (const Entry *)b;
    if (ea->is_dir != eb->is_dir) return eb->is_dir - ea->is_dir;
    return strcmp(ea->name, eb->name);
}

static void clamp_selected(void) {
    if (entry_count <= 0) {
        selected = 0;
        return;
    }
    if (selected < 0) selected = 0;
    if (selected >= entry_count) selected = entry_count - 1;
}

static void clamp_scroll(int visible_rows) {
    int max_scroll = entry_count > visible_rows ? entry_count - visible_rows : 0;
    if (scroll_row < 0) scroll_row = 0;
    if (scroll_row > max_scroll) scroll_row = max_scroll;
}

static void reveal_selected(int visible_rows) {
    clamp_selected();
    if (selected < scroll_row) scroll_row = selected;
    if (selected >= scroll_row + visible_rows) scroll_row = selected - visible_rows + 1;
    clamp_scroll(visible_rows);
}

static void load_dir(void) {
    DIR *d = opendir(cwd_path);
    entry_count = 0;
    selected = 0;
    scroll_row = 0;
    if (!d) {
        snprintf(status_line, sizeof(status_line), "opendir %s failed: %s", cwd_path, strerror(errno));
        return;
    }

    if (strcmp(cwd_path, "/")) {
        strcpy(entries[entry_count].name, "..");
        entries[entry_count].is_dir = 1;
        entries[entry_count].size = 0;
        entry_count++;
    }

    struct dirent *de;
    while ((de = readdir(d)) && entry_count < MAX_ENTRIES) {
        if (!strcmp(de->d_name, ".") || !strcmp(de->d_name, "..")) continue;
        Entry *e = &entries[entry_count++];
        snprintf(e->name, sizeof(e->name), "%s", de->d_name);
        char full[PATH_MAX];
        struct stat st;
        join_path(full, sizeof(full), cwd_path, de->d_name);
        if (stat(full, &st) == 0) {
            e->is_dir = S_ISDIR(st.st_mode);
            e->size = (unsigned long)st.st_size;
        } else {
            e->is_dir = de->d_type == DT_DIR;
            e->size = 0;
        }
    }
    int truncated = entry_count == MAX_ENTRIES;
    closedir(d);
    qsort(entries, (size_t)entry_count, sizeof(entries[0]), cmp_entries);
    snprintf(status_line, sizeof(status_line), "%d%s entries read from Kandelo VFS",
             entry_count, truncated ? "+" : "");
}

static void open_selected(void) {
    if (entry_count <= 0) return;
    clamp_selected();
    Entry *e = &entries[selected];
    if (!e->is_dir) {
        snprintf(status_line, sizeof(status_line), "selected file: %s (%lu bytes)", e->name, e->size);
        return;
    }
    if (!strcmp(e->name, "..")) {
        go_parent();
    } else {
        char next[PATH_MAX];
        join_path(next, sizeof(next), cwd_path, e->name);
        set_cwd_path(next);
    }
    load_dir();
}

static void format_size(const Entry *e, char *out, size_t n) {
    if (e->is_dir) {
        snprintf(out, n, "dir");
    } else if (e->size < 1024) {
        snprintf(out, n, "%lu B", e->size);
    } else if (e->size < 1024 * 1024) {
        snprintf(out, n, "%lu KB", (e->size + 1023) / 1024);
    } else {
        snprintf(out, n, "%lu MB", (e->size + 1024 * 1024 - 1) / (1024 * 1024));
    }
}

static void elide(char *out, size_t n, const char *in, int max_chars) {
    if (max_chars < 4) max_chars = 4;
    if ((int)strlen(in) <= max_chars) {
        snprintf(out, n, "%s", in);
        return;
    }
    snprintf(out, n, "%.*s...", max_chars - 3, in);
}

static void draw_button(Display *dpy, Drawable drawable, GC gc, const Palette *p,
                        int x, int y, int w, int h, const char *label, int active) {
    fill(dpy, drawable, gc, x, y, w, h, active ? p->select : p->panel);
    frame(dpy, drawable, gc, x, y, w, h, active ? p->bar : p->line);
    draw_text(dpy, drawable, gc, x + 10, y + 9, label, active ? p->text : p->muted, 1);
}

static int inside(int x, int y, int rx, int ry, int rw, int rh) {
    return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
}

static void draw_browser(Display *dpy, Window win, Pixmap back, GC gc, const Palette *p, int w, int h) {
    const int margin = 14;
    const int top_h = 58;
    const int sidebar_w = 160;
    const int list_x = margin + sidebar_w + 14;
    const int list_y = top_h + 18;
    const int list_w = w - list_x - margin;
    const int list_h = h - list_y - 46;
    const int row_h = 24;
    const int visible_rows = (list_h - 42) / row_h;

    fill(dpy, back, gc, 0, 0, w, h, p->bg);
    fill(dpy, back, gc, 0, 0, w, top_h, p->bar);
    draw_text(dpy, back, gc, margin + 2, 13, "KANDELO VFS BROWSER", p->white, 2);
    draw_text(dpy, back, gc, w - 238, 22, "XLIB CLIENT ON XFBDEV", p->black, 1);

    fill(dpy, back, gc, margin, list_y, sidebar_w, list_h, p->panel);
    frame(dpy, back, gc, margin, list_y, sidebar_w, list_h, p->line);
    draw_text(dpy, back, gc, margin + 12, list_y + 16, "PLACES", p->text, 1);
    draw_button(dpy, back, gc, p, margin + 12, list_y + 42, sidebar_w - 24, 28,
                "/", !strcmp(cwd_path, "/"));
    draw_button(dpy, back, gc, p, margin + 12, list_y + 78, sidebar_w - 24, 28,
                "/HOME", !strcmp(cwd_path, "/home"));
    draw_button(dpy, back, gc, p, margin + 12, list_y + 114, sidebar_w - 24, 28,
                "/USR/BIN", !strcmp(cwd_path, "/usr/bin"));
    draw_text(dpy, back, gc, margin + 12, list_y + list_h - 50, "POSIX READDIR", p->muted, 1);
    draw_text(dpy, back, gc, margin + 12, list_y + list_h - 34, "X11 DRAW CALLS", p->muted, 1);

    fill(dpy, back, gc, list_x, list_y, list_w, list_h, p->panel);
    frame(dpy, back, gc, list_x, list_y, list_w, list_h, p->line);
    draw_text(dpy, back, gc, list_x + 14, list_y + 15, cwd_path, p->text, 1);
    draw_text(dpy, back, gc, list_x + list_w - 118, list_y + 15, "SIZE", p->muted, 1);
    fill(dpy, back, gc, list_x + 1, list_y + 34, list_w - 2, 1, p->line);

    clamp_scroll(visible_rows);
    for (int row = 0; row < visible_rows; row++) {
        int idx = scroll_row + row;
        if (idx >= entry_count) break;
        int y = list_y + 42 + row * row_h;
        Entry *e = &entries[idx];
        if (idx == selected) fill(dpy, back, gc, list_x + 6, y - 2, list_w - 12, row_h, p->select);
        char label[NAME_LEN + 8];
        char shown[NAME_LEN + 8];
        snprintf(label, sizeof(label), "%s%s", e->is_dir ? "[D] " : "    ", e->name);
        elide(shown, sizeof(shown), label, (list_w - 140) / 6);
        draw_text(dpy, back, gc, list_x + 14, y + 5, shown, e->is_dir ? p->accent : p->text, 1);
        char size[32];
        format_size(e, size, sizeof(size));
        draw_text(dpy, back, gc, list_x + list_w - 118, y + 5, size, p->muted, 1);
    }

    fill(dpy, back, gc, margin, h - 34, w - 2 * margin, 20, p->black);
    draw_text(dpy, back, gc, margin + 9, h - 28, status_line, p->green, 1);
    XCopyArea(dpy, back, win, gc, 0, 0, (unsigned)w, (unsigned)h, 0, 0);
}

static void click_at(int x, int y, int w, int h) {
    const int margin = 14;
    const int top_h = 58;
    const int sidebar_w = 160;
    const int list_x = margin + sidebar_w + 14;
    const int list_y = top_h + 18;
    const int list_h = h - list_y - 46;
    const int row_h = 24;
    const int visible_rows = (list_h - 42) / row_h;

    if (inside(x, y, margin + 12, list_y + 42, sidebar_w - 24, 28)) {
        set_cwd_path("/");
        load_dir();
        return;
    }
    if (inside(x, y, margin + 12, list_y + 78, sidebar_w - 24, 28)) {
        set_cwd_path("/home");
        load_dir();
        return;
    }
    if (inside(x, y, margin + 12, list_y + 114, sidebar_w - 24, 28)) {
        set_cwd_path("/usr/bin");
        load_dir();
        return;
    }

    if (inside(x, y, list_x + 6, list_y + 40, w - list_x - margin - 12, visible_rows * row_h)) {
        int row = (y - (list_y + 40)) / row_h;
        int idx = scroll_row + row;
        if (idx >= 0 && idx < entry_count) {
            int was_selected = idx == selected;
            selected = idx;
            if (was_selected || entries[idx].is_dir) open_selected();
        }
    }
}

static Display *open_display_with_retry(void) {
    const char *display = getenv("DISPLAY");
    if (!display || !*display) {
        setenv("DISPLAY", ":0", 0);
    }
    fprintf(stderr, "xvfs-browser: opening DISPLAY=%s\n", getenv("DISPLAY") ? getenv("DISPLAY") : "");
    for (int attempt = 0; attempt < 80; attempt++) {
        Display *dpy = XOpenDisplay(NULL);
        if (dpy) {
            fprintf(stderr, "xvfs-browser: XOpenDisplay succeeded after %d attempt%s\n",
                    attempt + 1, attempt == 0 ? "" : "s");
            return dpy;
        }
        if (attempt == 0 || attempt == 9 || attempt == 39 || attempt == 79) {
            fprintf(stderr, "xvfs-browser: XOpenDisplay attempt %d failed\n", attempt + 1);
        }
        usleep(100000);
    }
    return NULL;
}

int main(int argc, char **argv) {
    if (argc > 1) set_cwd_path(argv[1]);
    load_dir();
    fprintf(stderr, "xvfs-browser: loaded %d entries from %s\n", entry_count, cwd_path);

    Display *dpy = open_display_with_retry();
    if (!dpy) {
        fprintf(stderr, "xvfs-browser: could not open DISPLAY=%s\n", getenv("DISPLAY") ? getenv("DISPLAY") : "");
        return 1;
    }
    XSetIOErrorHandler(handle_x_io_error);

    int screen = DefaultScreen(dpy);
    int width = DisplayWidth(dpy, screen);
    int height = DisplayHeight(dpy, screen);
    if (width <= 0) width = 640;
    if (height <= 0) height = 480;

    Palette palette = make_palette(dpy, screen);
    Window root = RootWindow(dpy, screen);
    Window win = XCreateSimpleWindow(dpy, root, 0, 0, (unsigned)width, (unsigned)height,
                                     0, palette.black, palette.bg);
    fprintf(stderr, "xvfs-browser: created %dx%d window\n", width, height);
    XStoreName(dpy, win, "Kandelo VFS Browser");
    Atom wm_delete_window = XInternAtom(dpy, "WM_DELETE_WINDOW", False);
    XSetWMProtocols(dpy, win, &wm_delete_window, 1);
    XClassHint class_hint;
    class_hint.res_name = "xvfs-browser";
    class_hint.res_class = "XvfsBrowser";
    XSetClassHint(dpy, win, &class_hint);
    XSizeHints size_hints;
    memset(&size_hints, 0, sizeof(size_hints));
    size_hints.flags = PPosition | PSize;
    size_hints.x = 0;
    size_hints.y = 0;
    size_hints.width = width;
    size_hints.height = height;
    XSetWMNormalHints(dpy, win, &size_hints);
    XSelectInput(dpy, win, ExposureMask | ButtonPressMask | KeyPressMask | StructureNotifyMask);
    GC gc = XCreateGC(dpy, win, 0, NULL);
    Pixmap back = XCreatePixmap(dpy, root, (unsigned)width, (unsigned)height,
                                (unsigned)DefaultDepth(dpy, screen));
    XMapRaised(dpy, win);
    XFlush(dpy);
    usleep(100000);
    XSetInputFocus(dpy, win, RevertToParent, CurrentTime);
    fprintf(stderr, "xvfs-browser: mapped window and entering event loop\n");

    int needs_draw = 1;
    int running = 1;
    int heartbeat = 0;
    while (running) {
        while (running && XPending(dpy) > 0) {
            XEvent ev;
            XNextEvent(dpy, &ev);
            if (ev.type == Expose) {
                needs_draw = 1;
            } else if (ev.type == ConfigureNotify) {
                if (width != ev.xconfigure.width || height != ev.xconfigure.height) {
                    width = ev.xconfigure.width;
                    height = ev.xconfigure.height;
                    XFreePixmap(dpy, back);
                    back = XCreatePixmap(dpy, root, (unsigned)width, (unsigned)height,
                                         (unsigned)DefaultDepth(dpy, screen));
                }
                needs_draw = 1;
            } else if (ev.type == ClientMessage) {
                if ((Atom)ev.xclient.data.l[0] == wm_delete_window) {
                    fprintf(stderr, "xvfs-browser: WM_DELETE_WINDOW received\n");
                    running = 0;
                }
            } else if (ev.type == ButtonPress) {
                click_at(ev.xbutton.x, ev.xbutton.y, width, height);
                needs_draw = 1;
            } else if (ev.type == KeyPress) {
                KeySym key = XLookupKeysym(&ev.xkey, 0);
                int visible_rows = (height - (58 + 18) - 46 - 42) / 24;
                if (visible_rows < 1) visible_rows = 1;
                if (key == XK_q || key == XK_Escape) {
                    running = 0;
                } else if (key == XK_Up) selected--;
                else if (key == XK_Down) selected++;
                else if (key == XK_Page_Up) selected -= visible_rows;
                else if (key == XK_Page_Down) selected += visible_rows;
                else if (key == XK_Return || key == XK_KP_Enter) open_selected();
                else if (key == XK_BackSpace) { go_parent(); load_dir(); }
                else if (key == XK_r || key == XK_R) load_dir();
                else if (key == XK_h || key == XK_H) { set_cwd_path("/home"); load_dir(); }
                else if (key == XK_slash) { set_cwd_path("/"); load_dir(); }
                reveal_selected(visible_rows);
                needs_draw = 1;
            }
        }
        if (needs_draw) {
            draw_browser(dpy, win, back, gc, &palette, width, height);
            XFlush(dpy);
            needs_draw = 0;
        }
        if (++heartbeat >= 30) {
            XNoOp(dpy);
            XFlush(dpy);
            heartbeat = 0;
        }
        usleep(16000);
    }

    XFreeGC(dpy, gc);
    XFreePixmap(dpy, back);
    XDestroyWindow(dpy, win);
    XCloseDisplay(dpy);
    return 0;
}
