/*
 * kdesktop — small Kandelo framebuffer desktop lab.
 *
 * This is intentionally a real guest process, not a React mock: it opens
 * /dev/fb0, mmaps the framebuffer, reads /dev/input/event0 with a
 * /dev/input/mice fallback, and lists files with opendir/readdir/stat
 * against the Kandelo VFS.
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fb.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#define MAX_ENTRIES 64
#define NAME_LEN 72
#define VISIBLE_ROWS 14

typedef struct {
    char name[NAME_LEN];
    int is_dir;
    unsigned long size;
} Entry;

static uint32_t *fb;
static uint32_t *back;
static int sw, sh, stride;
static int mx = 320, my = 200, buttons = 0, last_buttons = 0;
static char cwd[256] = "/home";
static Entry entries[MAX_ENTRIES];
static int entry_count = 0;
static int scroll = 0;
static int selected = 0;
static char status_line[160] = "Reading /home from Kandelo VFS";
static char mode_line[80] = "FBDEV";
static char input_line[24] = "MICE";
static char key_line[24] = "NOKEY";

static const uint32_t C_BG      = 0xff2a2f35;
static const uint32_t C_PANEL   = 0xfff4ead7;
static const uint32_t C_BAR     = 0xffd85f2b;
static const uint32_t C_WIN     = 0xfffbf7ed;
static const uint32_t C_LINE    = 0xffbba983;
static const uint32_t C_TEXT    = 0xff24190f;
static const uint32_t C_MUTED   = 0xff76684f;
static const uint32_t C_BLUE    = 0xff2f7c8f;
static const uint32_t C_GREEN   = 0xff5f8f73;
static const uint32_t C_SELECT  = 0xffffdca8;
static const uint32_t C_WHITE   = 0xffffffff;
static const uint32_t C_BLACK   = 0xff000000;

static uint32_t blend(uint32_t a, uint32_t b, int t) {
    int ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    int br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    int r = (ar * (255 - t) + br * t) / 255;
    int g = (ag * (255 - t) + bg * t) / 255;
    int bl = (ab * (255 - t) + bb * t) / 255;
    return 0xff000000u | (uint32_t)(r << 16) | (uint32_t)(g << 8) | (uint32_t)bl;
}

static void px(int x, int y, uint32_t c) {
    if ((unsigned)x >= (unsigned)sw || (unsigned)y >= (unsigned)sh) return;
    back[y * stride + x] = c;
}

static void rect(int x, int y, int w, int h, uint32_t c) {
    int x0 = x < 0 ? 0 : x, y0 = y < 0 ? 0 : y;
    int x1 = x + w > sw ? sw : x + w, y1 = y + h > sh ? sh : y + h;
    for (int yy = y0; yy < y1; yy++) {
        for (int xx = x0; xx < x1; xx++) px(xx, yy, c);
    }
}

static void frame(int x, int y, int w, int h, uint32_t c) {
    rect(x, y, w, 1, c); rect(x, y + h - 1, w, 1, c);
    rect(x, y, 1, h, c); rect(x + w - 1, y, 1, h, c);
}

static const uint8_t *glyph(char c) {
    static const uint8_t blank[7] = {0,0,0,0,0,0,0};
    static const uint8_t unk[7] = {14,17,1,2,4,0,4};
    static const uint8_t tbl[43][7] = {
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
        {1,2,4,8,16,0,0}
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
    return c ? unk : blank;
}

static void text(int x, int y, const char *s, uint32_t c) {
    for (; *s; s++, x += 6) {
        const uint8_t *g = glyph(*s);
        for (int yy = 0; yy < 7; yy++)
            for (int xx = 0; xx < 5; xx++)
                if (g[yy] & (1 << (4 - xx))) px(x + xx, y + yy, c);
    }
}

static void join_path(char *out, size_t n, const char *base, const char *name) {
    if (!strcmp(base, "/")) snprintf(out, n, "/%s", name);
    else snprintf(out, n, "%s/%s", base, name);
}

static void go_parent(void) {
    if (!strcmp(cwd, "/")) return;
    char *slash = strrchr(cwd, '/');
    if (!slash || slash == cwd) strcpy(cwd, "/");
    else *slash = 0;
}

static void set_cwd(const char *path) {
    snprintf(cwd, sizeof(cwd), "%s", path);
}

static int cmp_entries(const void *a, const void *b) {
    const Entry *ea = (const Entry *)a, *eb = (const Entry *)b;
    if (ea->is_dir != eb->is_dir) return eb->is_dir - ea->is_dir;
    return strcmp(ea->name, eb->name);
}

static void clamp_scroll(void) {
    int max_scroll = entry_count > VISIBLE_ROWS ? entry_count - VISIBLE_ROWS : 0;
    if (scroll < 0) scroll = 0;
    if (scroll > max_scroll) scroll = max_scroll;
}

static void clamp_selected(void) {
    if (entry_count <= 0) {
        selected = 0;
        return;
    }
    if (selected < 0) selected = 0;
    if (selected >= entry_count) selected = entry_count - 1;
}

static void reveal_selected(void) {
    clamp_selected();
    if (selected < scroll) scroll = selected;
    if (selected >= scroll + VISIBLE_ROWS) {
        scroll = selected >= VISIBLE_ROWS ? selected - VISIBLE_ROWS + 1 : 0;
    }
    clamp_scroll();
}

static void load_dir(void) {
    DIR *d = opendir(cwd);
    entry_count = 0;
    scroll = 0;
    selected = 0;
    if (!d) {
        snprintf(status_line, sizeof(status_line), "opendir failed: %s", strerror(errno));
        return;
    }
    if (strcmp(cwd, "/")) {
        strcpy(entries[entry_count].name, "..");
        entries[entry_count].is_dir = 1;
        entries[entry_count].size = 0;
        entry_count++;
    }
    struct dirent *de;
    while ((de = readdir(d)) && entry_count < MAX_ENTRIES) {
        if (!strcmp(de->d_name, ".")) continue;
        if (!strcmp(de->d_name, "..")) continue;
        Entry *e = &entries[entry_count++];
        snprintf(e->name, sizeof(e->name), "%s", de->d_name);
        char full[320];
        struct stat st;
        join_path(full, sizeof(full), cwd, de->d_name);
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
    qsort(entries, entry_count, sizeof(entries[0]), cmp_entries);
    clamp_selected();
    clamp_scroll();
    snprintf(status_line, sizeof(status_line), "%d%s entries read from Kandelo VFS", entry_count, truncated ? "+" : "");
}

static int inside(int x, int y, int rx, int ry, int rw, int rh) {
    return x >= rx && y >= ry && x < rx + rw && y < ry + rh;
}

static void activate_index(int idx) {
    if (idx < 0 || idx >= entry_count) return;
    selected = idx;
    reveal_selected();
    Entry *e = &entries[idx];
    if (!strcmp(e->name, "..")) {
        go_parent();
        load_dir();
    } else if (e->is_dir) {
        char next[256];
        join_path(next, sizeof(next), cwd, e->name);
        set_cwd(next);
        load_dir();
    } else {
        snprintf(status_line, sizeof(status_line), "%s is a file (%lu bytes)", e->name, e->size);
    }
}

static void activate_selected(void) {
    activate_index(selected);
}

static void activate(int x, int y) {
    if (inside(x, y, 18, 54, 46, 42)) { set_cwd("/"); load_dir(); return; }
    if (inside(x, y, 18, 108, 46, 42)) { set_cwd("/home"); load_dir(); return; }
    if (inside(x, y, 18, 162, 46, 42)) { set_cwd("/usr/bin"); load_dir(); return; }
    if (inside(x, y, 94, 92, 72, 18)) { go_parent(); load_dir(); return; }

    int row = (y - 124) / 16;
    int idx = scroll + row;
    if (x >= 96 && x < 584 && row >= 0 && row < VISIBLE_ROWS) activate_index(idx);
}

static void draw_icon(int x, int y, uint32_t color, const char *label) {
    rect(x, y + 8, 38, 28, blend(C_PANEL, color, 40));
    frame(x, y + 8, 38, 28, color);
    rect(x + 5, y + 3, 18, 8, color);
    text(x - 2, y + 40, label, C_PANEL);
}

static void draw_cursor(void) {
    for (int i = 0; i < 15; i++) {
        for (int j = 0; j <= i / 2; j++) px(mx + j, my + i, C_WHITE);
    }
    for (int i = 0; i < 15; i++) px(mx, my + i, C_BLACK);
    for (int j = 0; j < 8; j++) px(mx + j, my + 14, C_BLACK);
}

static void draw(void) {
    rect(0, 0, sw, sh, C_BG);
    rect(0, 0, sw, 28, C_BAR);
    text(10, 10, "KANDELO DESKTOP LAB", C_WHITE);
    text(450, 10, mode_line, C_WHITE);

    draw_icon(20, 54, C_BLUE, "ROOT");
    draw_icon(20, 108, C_GREEN, "HOME");
    draw_icon(20, 162, C_BAR, "BIN");

    rect(82, 48, 524, 316, C_WIN);
    frame(82, 48, 524, 316, C_LINE);
    rect(82, 48, 524, 26, C_BLUE);
    text(94, 58, "VFS FILE MANAGER", C_WHITE);
    text(94, 84, "PATH:", C_MUTED);
    text(130, 84, cwd, C_TEXT);
    rect(94, 92, 72, 18, C_SELECT);
    frame(94, 92, 72, 18, C_LINE);
    text(106, 98, "UP", C_TEXT);
    text(182, 98, status_line, C_MUTED);

    rect(94, 118, 494, 1, C_LINE);
    for (int i = 0; i < VISIBLE_ROWS && scroll + i < entry_count; i++) {
        int y = 124 + i * 16;
        int idx = scroll + i;
        Entry *e = &entries[idx];
        if (idx == selected) rect(94, y - 4, 494, 15, C_SELECT);
        else if (inside(mx, my, 96, y - 3, 488, 14)) rect(94, y - 4, 494, 15, blend(C_WIN, C_SELECT, 110));
        text(102, y, e->is_dir ? "DIR" : "FILE", e->is_dir ? C_BLUE : C_MUTED);
        text(134, y, e->name, C_TEXT);
    }
    if (entry_count > VISIBLE_ROWS) {
        char page[32];
        snprintf(page, sizeof(page), "%d-%d/%d", scroll + 1, scroll + VISIBLE_ROWS < entry_count ? scroll + VISIBLE_ROWS : entry_count, entry_count);
        text(512, 98, page, C_MUTED);
    }

    rect(82, 372, 524, 20, C_PANEL);
    text(92, 379, "ARROWS ENTER BACKSPACE H R B. CLICK DIRS TO BROWSE REAL VFS.", C_TEXT);
    draw_cursor();
}

static void present(void) {
    for (int y = 0; y < sh; y++) {
        memcpy(fb + y * stride, back + y * stride, (size_t)sw * sizeof(uint32_t));
    }
}

static int rd_i32(const uint8_t *p) {
    return (int32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24));
}

static uint16_t rd_u16(const uint8_t *p) {
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static void clamp_mouse(void) {
    if (mx < 0) mx = 0;
    if (my < 0) my = 0;
    if (mx >= sw) mx = sw - 1;
    if (my >= sh) my = sh - 1;
}

static void maybe_activate(void) {
    if ((buttons & 1) && !(last_buttons & 1)) activate(mx, my);
    last_buttons = buttons;
}

static void move_selected(int delta) {
    selected += delta;
    reveal_selected();
    snprintf(status_line, sizeof(status_line), "selected %d/%d", entry_count ? selected + 1 : 0, entry_count);
}

static void handle_mice(int mfd) {
    uint8_t p[3];
    while (read(mfd, p, sizeof(p)) == 3) {
        buttons = p[0] & 7;
        mx += (int8_t)p[1];
        my -= (int8_t)p[2];
        clamp_mouse();
        maybe_activate();
    }
}

static void handle_event0(int efd) {
    uint8_t ev[16];
    while (read(efd, ev, sizeof(ev)) == 16) {
        uint16_t type = rd_u16(ev + 8);
        uint16_t code = rd_u16(ev + 10);
        int value = rd_i32(ev + 12);
        if (type == 0x02) {
            if (code == 0x00) mx += value;       /* REL_X */
            else if (code == 0x01) my += value;  /* REL_Y, positive down */
            else if (code == 0x08) {             /* REL_WHEEL, positive up */
                scroll -= value;
                clamp_scroll();
                if (selected < scroll) selected = scroll;
                if (selected >= scroll + VISIBLE_ROWS) selected = scroll + VISIBLE_ROWS - 1;
                clamp_selected();
                snprintf(status_line, sizeof(status_line), "wheel scroll %d/%d", scroll, entry_count);
            }
            clamp_mouse();
        } else if (type == 0x01) {
            int bit = 0;
            if (code == 0x110) bit = 1;          /* BTN_LEFT */
            else if (code == 0x111) bit = 2;     /* BTN_RIGHT */
            else if (code == 0x112) bit = 4;     /* BTN_MIDDLE */
            if (bit) {
                if (value) buttons |= bit;
                else buttons &= ~bit;
                maybe_activate();
            }
        }
    }
}

static void handle_event1(int kfd) {
    uint8_t ev[16];
    while (read(kfd, ev, sizeof(ev)) == 16) {
        uint16_t type = rd_u16(ev + 8);
        uint16_t code = rd_u16(ev + 10);
        int value = rd_i32(ev + 12);
        if (type != 0x01 || value == 0) continue; /* EV_KEY press only */
        if (code == 14) { /* KEY_BACKSPACE */
            go_parent();
            load_dir();
            snprintf(status_line, sizeof(status_line), "keyboard: BACKSPACE -> parent");
        } else if (code == 28) { /* KEY_ENTER */
            activate_selected();
        } else if (code == 103) { /* KEY_UP */
            move_selected(-1);
        } else if (code == 108) { /* KEY_DOWN */
            move_selected(1);
        } else if (code == 35) { /* KEY_H */
            set_cwd("/home");
            load_dir();
            snprintf(status_line, sizeof(status_line), "keyboard: H -> /home");
        } else if (code == 19) { /* KEY_R */
            set_cwd("/");
            load_dir();
            snprintf(status_line, sizeof(status_line), "keyboard: R -> /");
        } else if (code == 48) { /* KEY_B */
            set_cwd("/usr/bin");
            load_dir();
            snprintf(status_line, sizeof(status_line), "keyboard: B -> /usr/bin");
        } else {
            snprintf(status_line, sizeof(status_line), "keyboard: KEY %u", (unsigned)code);
        }
    }
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    printf("kdesktop: starting\n");

    int fd = open("/dev/fb0", O_RDWR);
    if (fd < 0) { perror("open /dev/fb0"); return 1; }

    struct fb_var_screeninfo v;
    struct fb_fix_screeninfo f;
    if (ioctl(fd, FBIOGET_VSCREENINFO, &v) < 0) { perror("FBIOGET_VSCREENINFO"); return 1; }
    v.xres = 640;
    v.yres = 480;
    v.xres_virtual = 640;
    v.yres_virtual = 480;
    v.bits_per_pixel = 32;
    if (ioctl(fd, FBIOPUT_VSCREENINFO, &v) < 0) {
        /* Older kernels only expose the legacy default mode. */
        perror("FBIOPUT_VSCREENINFO 640x480");
        snprintf(mode_line, sizeof(mode_line), "FBDEV %dX%d", (int)v.xres, (int)v.yres);
    }
    if (ioctl(fd, FBIOGET_VSCREENINFO, &v) < 0) { perror("FBIOGET_VSCREENINFO"); return 1; }
    if (ioctl(fd, FBIOGET_FSCREENINFO, &f) < 0) { perror("FBIOGET_FSCREENINFO"); return 1; }
    sw = (int)v.xres; sh = (int)v.yres;
    stride = f.line_length ? (int)f.line_length / 4 : sw;
    if (sw <= 0 || sh <= 0 || stride < sw || f.smem_len == 0 || v.bits_per_pixel != 32) {
        fprintf(stderr,
                "kdesktop: unsupported framebuffer %dx%d stride=%d bpp=%u len=%u\n",
                sw,
                sh,
                stride,
                v.bits_per_pixel,
                f.smem_len);
        return 1;
    }
    mx = sw / 2;
    my = sh / 2;
    snprintf(mode_line, sizeof(mode_line), "FBDEV %dX%d", sw, sh);
    printf("kdesktop: fbdev %dx%d stride=%d bpp=%u len=%u\n",
           sw,
           sh,
           stride,
           v.bits_per_pixel,
           f.smem_len);

    fb = mmap(NULL, f.smem_len, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (fb == MAP_FAILED) { perror("mmap /dev/fb0"); return 1; }
    back = calloc((size_t)stride * (size_t)sh, sizeof(uint32_t));
    if (!back) { perror("calloc back buffer"); return 1; }

    int efd = open("/dev/input/event0", O_RDONLY | O_NONBLOCK);
    int kfd = open("/dev/input/event1", O_RDONLY | O_NONBLOCK);
    int mfd = -1;
    if (efd >= 0) {
        snprintf(input_line, sizeof(input_line), "EVDEV");
    } else {
        mfd = open("/dev/input/mice", O_RDONLY | O_NONBLOCK);
        if (mfd >= 0) snprintf(input_line, sizeof(input_line), "MICE");
        else snprintf(status_line, sizeof(status_line), "mouse unavailable: %s", strerror(errno));
    }
    if (kfd >= 0) snprintf(key_line, sizeof(key_line), "KEY");
    snprintf(mode_line, sizeof(mode_line), "FBDEV %dX%d %s+%s", sw, sh, input_line, key_line);
    printf("kdesktop: input pointer=%s keyboard=%s\n", input_line, key_line);
    load_dir();
    write(1, "kdesktop ready\n", 15);

    for (;;) {
        if (efd >= 0) handle_event0(efd);
        else if (mfd >= 0) handle_mice(mfd);
        if (kfd >= 0) handle_event1(kfd);
        draw();
        present();
        usleep(16000);
    }
}
