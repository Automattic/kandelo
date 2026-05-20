/*
 * xclock - a tiny libX11 clock for the Kandelo desktop demo.
 *
 * This intentionally avoids Xt/Xaw so the first multi-client desktop milestone
 * can stay on the existing libX11-only dependency set.
 */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef struct {
    unsigned long bg;
    unsigned long face;
    unsigned long tick;
    unsigned long hour;
    unsigned long minute;
    unsigned long second;
    unsigned long border;
} Palette;

static int handle_x_io_error(Display *dpy) {
    (void)dpy;
    fprintf(stderr, "xclock: X connection closed\n");
    fflush(stderr);
    _exit(0);
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
    p.bg = alloc_rgb(dpy, cmap, 24, 32, 38);
    p.face = alloc_rgb(dpy, cmap, 251, 247, 237);
    p.tick = alloc_rgb(dpy, cmap, 47, 124, 143);
    p.hour = alloc_rgb(dpy, cmap, 36, 25, 15);
    p.minute = alloc_rgb(dpy, cmap, 216, 95, 43);
    p.second = alloc_rgb(dpy, cmap, 180, 38, 30);
    p.border = alloc_rgb(dpy, cmap, 187, 169, 131);
    return p;
}

static Display *open_display_with_retry(void) {
    if (!getenv("DISPLAY") || !*getenv("DISPLAY")) setenv("DISPLAY", ":0", 0);
    fprintf(stderr, "xclock: opening DISPLAY=%s\n", getenv("DISPLAY"));
    for (int attempt = 0; attempt < 80; attempt++) {
        Display *dpy = XOpenDisplay(NULL);
        if (dpy) {
            fprintf(stderr, "xclock: XOpenDisplay succeeded after %d attempt%s\n",
                    attempt + 1, attempt == 0 ? "" : "s");
            return dpy;
        }
        usleep(100000);
    }
    return NULL;
}

static void draw_hand(Display *dpy, Drawable drawable, GC gc, int cx, int cy,
                      double angle, int len, int width, unsigned long color) {
    int x = cx + (int)lrint(sin(angle) * len);
    int y = cy - (int)lrint(cos(angle) * len);
    XSetForeground(dpy, gc, color);
    XSetLineAttributes(dpy, gc, (unsigned)width, LineSolid, CapRound, JoinRound);
    XDrawLine(dpy, drawable, gc, cx, cy, x, y);
}

static void draw_clock(Display *dpy, Window win, Pixmap back, GC gc, const Palette *p, int w, int h) {
    int size = (w < h ? w : h) - 18;
    if (size < 30) size = 30;
    int cx = w / 2;
    int cy = h / 2;
    int r = size / 2;

    XSetForeground(dpy, gc, p->bg);
    XFillRectangle(dpy, back, gc, 0, 0, (unsigned)w, (unsigned)h);
    XSetForeground(dpy, gc, p->face);
    XFillArc(dpy, back, gc, cx - r, cy - r, (unsigned)(2 * r), (unsigned)(2 * r), 0, 360 * 64);
    XSetForeground(dpy, gc, p->border);
    XSetLineAttributes(dpy, gc, 2, LineSolid, CapRound, JoinRound);
    XDrawArc(dpy, back, gc, cx - r, cy - r, (unsigned)(2 * r), (unsigned)(2 * r), 0, 360 * 64);

    for (int i = 0; i < 60; i++) {
        double a = (double)i * M_PI / 30.0;
        int outer = r - 5;
        int inner = r - (i % 5 == 0 ? 16 : 10);
        int x1 = cx + (int)lrint(sin(a) * inner);
        int y1 = cy - (int)lrint(cos(a) * inner);
        int x2 = cx + (int)lrint(sin(a) * outer);
        int y2 = cy - (int)lrint(cos(a) * outer);
        XSetForeground(dpy, gc, i % 5 == 0 ? p->minute : p->tick);
        XSetLineAttributes(dpy, gc, i % 5 == 0 ? 2 : 1, LineSolid, CapRound, JoinRound);
        XDrawLine(dpy, back, gc, x1, y1, x2, y2);
    }

    time_t now = time(NULL);
    struct tm tm_now;
    localtime_r(&now, &tm_now);
    double sec = (double)tm_now.tm_sec;
    double min = (double)tm_now.tm_min + sec / 60.0;
    double hour = (double)(tm_now.tm_hour % 12) + min / 60.0;
    draw_hand(dpy, back, gc, cx, cy, hour * M_PI / 6.0, r * 48 / 100, 5, p->hour);
    draw_hand(dpy, back, gc, cx, cy, min * M_PI / 30.0, r * 70 / 100, 3, p->minute);
    draw_hand(dpy, back, gc, cx, cy, sec * M_PI / 30.0, r * 78 / 100, 1, p->second);
    XSetForeground(dpy, gc, p->hour);
    XFillArc(dpy, back, gc, cx - 5, cy - 5, 10, 10, 0, 360 * 64);
    XCopyArea(dpy, back, win, gc, 0, 0, (unsigned)w, (unsigned)h, 0, 0);
    XFlush(dpy);
}

int main(int argc, char **argv, char **envp) {
    (void)argc;
    (void)argv;
    (void)envp;
    Display *dpy = open_display_with_retry();
    if (!dpy) {
        fprintf(stderr, "xclock: could not open DISPLAY\n");
        return 1;
    }
    XSetIOErrorHandler(handle_x_io_error);

    int screen = DefaultScreen(dpy);
    Palette palette = make_palette(dpy, screen);
    Window root = RootWindow(dpy, screen);
    int width = 196;
    int height = 158;
    Window win = XCreateSimpleWindow(dpy, root, 0, 0, (unsigned)width, (unsigned)height,
                                     0, palette.border, palette.bg);
    XStoreName(dpy, win, "xclock");
    Atom wm_delete_window = XInternAtom(dpy, "WM_DELETE_WINDOW", False);
    XSetWMProtocols(dpy, win, &wm_delete_window, 1);

    XClassHint class_hint;
    class_hint.res_name = "xclock";
    class_hint.res_class = "XClock";
    XSetClassHint(dpy, win, &class_hint);
    XSizeHints size_hints;
    memset(&size_hints, 0, sizeof(size_hints));
    size_hints.flags = PSize | PMinSize;
    size_hints.width = width;
    size_hints.height = height;
    size_hints.min_width = 96;
    size_hints.min_height = 96;
    XSetWMNormalHints(dpy, win, &size_hints);

    XSelectInput(dpy, win, ExposureMask | StructureNotifyMask);
    GC gc = XCreateGC(dpy, win, 0, NULL);
    Pixmap back = XCreatePixmap(dpy, root, (unsigned)width, (unsigned)height,
                                (unsigned)DefaultDepth(dpy, screen));
    XMapRaised(dpy, win);
    XFlush(dpy);
    fprintf(stderr, "xclock: mapped window and entering event loop\n");

    int running = 1;
    int needs_draw = 1;
    int heartbeat = 0;
    while (running) {
        while (running && XPending(dpy) > 0) {
            XEvent ev;
            XNextEvent(dpy, &ev);
            if (ev.type == Expose || ev.type == ConfigureNotify) {
                if (ev.type == ConfigureNotify) {
                    if (width != ev.xconfigure.width || height != ev.xconfigure.height) {
                        width = ev.xconfigure.width;
                        height = ev.xconfigure.height;
                        XFreePixmap(dpy, back);
                        back = XCreatePixmap(dpy, root, (unsigned)width, (unsigned)height,
                                             (unsigned)DefaultDepth(dpy, screen));
                    }
                }
                needs_draw = 1;
            } else if (ev.type == ClientMessage) {
                if ((Atom)ev.xclient.data.l[0] == wm_delete_window) running = 0;
            }
        }
        if (needs_draw || ++heartbeat >= 60) {
            draw_clock(dpy, win, back, gc, &palette, width, height);
            needs_draw = 0;
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
