/*
 * xeyes - a tiny libX11 eyes client for the Kandelo desktop demo.
 *
 * This keeps the dependency surface to libX11 while still exercising a
 * separate animated X client managed by JWM.
 */
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
    unsigned long bg;
    unsigned long face;
    unsigned long outline;
    unsigned long pupil;
    unsigned long shine;
    unsigned long accent;
} Palette;

static int handle_x_io_error(Display *dpy) {
    (void)dpy;
    fprintf(stderr, "xeyes: X connection closed\n");
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
    p.outline = alloc_rgb(dpy, cmap, 47, 124, 143);
    p.pupil = alloc_rgb(dpy, cmap, 36, 25, 15);
    p.shine = alloc_rgb(dpy, cmap, 255, 255, 255);
    p.accent = alloc_rgb(dpy, cmap, 216, 95, 43);
    return p;
}

static Display *open_display_with_retry(void) {
    if (!getenv("DISPLAY") || !*getenv("DISPLAY")) setenv("DISPLAY", ":0", 0);
    fprintf(stderr, "xeyes: opening DISPLAY=%s\n", getenv("DISPLAY"));
    for (int attempt = 0; attempt < 80; attempt++) {
        Display *dpy = XOpenDisplay(NULL);
        if (dpy) {
            fprintf(stderr, "xeyes: XOpenDisplay succeeded after %d attempt%s\n",
                    attempt + 1, attempt == 0 ? "" : "s");
            return dpy;
        }
        usleep(100000);
    }
    return NULL;
}

static void draw_eye(Display *dpy, Drawable drawable, GC gc, const Palette *p,
                     int cx, int cy, int rx, int ry, int target_x, int target_y) {
    XSetForeground(dpy, gc, p->face);
    XFillArc(dpy, drawable, gc, cx - rx, cy - ry, (unsigned)(2 * rx), (unsigned)(2 * ry), 0, 360 * 64);
    XSetForeground(dpy, gc, p->outline);
    XSetLineAttributes(dpy, gc, 3, LineSolid, CapRound, JoinRound);
    XDrawArc(dpy, drawable, gc, cx - rx, cy - ry, (unsigned)(2 * rx), (unsigned)(2 * ry), 0, 360 * 64);

    double dx = (double)(target_x - cx);
    double dy = (double)(target_y - cy);
    double dist = sqrt(dx * dx + dy * dy);
    double max_dx = (double)(rx - 18);
    double max_dy = (double)(ry - 18);
    int px = cx;
    int py = cy;
    if (dist > 0.1) {
        px = cx + (int)lrint(dx / dist * max_dx);
        py = cy + (int)lrint(dy / dist * max_dy);
    }

    XSetForeground(dpy, gc, p->pupil);
    XFillArc(dpy, drawable, gc, px - 12, py - 12, 24, 24, 0, 360 * 64);
    XSetForeground(dpy, gc, p->shine);
    XFillArc(dpy, drawable, gc, px - 5, py - 7, 7, 7, 0, 360 * 64);
}

static void draw_eyes(Display *dpy, Window win, Pixmap back, GC gc, const Palette *p,
                      int w, int h, int target_x, int target_y) {
    XSetForeground(dpy, gc, p->bg);
    XFillRectangle(dpy, back, gc, 0, 0, (unsigned)w, (unsigned)h);

    int margin = 14;
    int gap = 12;
    int eye_w = (w - 2 * margin - gap) / 2;
    int eye_h = h - 2 * margin;
    if (eye_w < 36) eye_w = 36;
    if (eye_h < 42) eye_h = 42;
    int rx = eye_w / 2;
    int ry = eye_h / 2;
    int cy = h / 2;
    int left_cx = margin + rx;
    int right_cx = margin + eye_w + gap + rx;

    draw_eye(dpy, back, gc, p, left_cx, cy, rx, ry, target_x, target_y);
    draw_eye(dpy, back, gc, p, right_cx, cy, rx, ry, target_x, target_y);
    XSetForeground(dpy, gc, p->accent);
    XSetLineAttributes(dpy, gc, 2, LineSolid, CapRound, JoinRound);
    XDrawLine(dpy, back, gc, left_cx + rx - 3, cy, right_cx - rx + 3, cy);
    XCopyArea(dpy, back, win, gc, 0, 0, (unsigned)w, (unsigned)h, 0, 0);
    XFlush(dpy);
}

int main(int argc, char **argv, char **envp) {
    (void)argc;
    (void)argv;
    (void)envp;
    Display *dpy = open_display_with_retry();
    if (!dpy) {
        fprintf(stderr, "xeyes: could not open DISPLAY\n");
        return 1;
    }
    XSetIOErrorHandler(handle_x_io_error);

    int screen = DefaultScreen(dpy);
    Palette palette = make_palette(dpy, screen);
    Window root = RootWindow(dpy, screen);
    int width = 196;
    int height = 130;
    Window win = XCreateSimpleWindow(dpy, root, 0, 0, (unsigned)width, (unsigned)height,
                                     0, palette.outline, palette.bg);
    XStoreName(dpy, win, "xeyes");
    Atom wm_delete_window = XInternAtom(dpy, "WM_DELETE_WINDOW", False);
    XSetWMProtocols(dpy, win, &wm_delete_window, 1);

    XClassHint class_hint;
    class_hint.res_name = "xeyes";
    class_hint.res_class = "XEyes";
    XSetClassHint(dpy, win, &class_hint);
    XSizeHints size_hints;
    memset(&size_hints, 0, sizeof(size_hints));
    size_hints.flags = PSize | PMinSize;
    size_hints.width = width;
    size_hints.height = height;
    size_hints.min_width = 96;
    size_hints.min_height = 72;
    XSetWMNormalHints(dpy, win, &size_hints);

    XSelectInput(dpy, win, ExposureMask | StructureNotifyMask);
    GC gc = XCreateGC(dpy, win, 0, NULL);
    Pixmap back = XCreatePixmap(dpy, root, (unsigned)width, (unsigned)height, (unsigned)DefaultDepth(dpy, screen));
    XMapRaised(dpy, win);
    XFlush(dpy);
    fprintf(stderr, "xeyes: mapped window and entering event loop\n");

    int running = 1;
    int needs_draw = 1;
    int target_x = width / 2;
    int target_y = height / 2;
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

        Window unused_root, unused_child;
        int root_x, root_y, win_x, win_y;
        unsigned int mask;
        if (XQueryPointer(dpy, win, &unused_root, &unused_child,
                          &root_x, &root_y, &win_x, &win_y, &mask)) {
            if (target_x != win_x || target_y != win_y) {
                target_x = win_x;
                target_y = win_y;
                needs_draw = 1;
            }
        }
        if (needs_draw) {
            draw_eyes(dpy, win, back, gc, &palette, width, height, target_x, target_y);
            needs_draw = 0;
        }
        usleep(50000);
    }

    XFreeGC(dpy, gc);
    XFreePixmap(dpy, back);
    XDestroyWindow(dpy, win);
    XCloseDisplay(dpy);
    return 0;
}
