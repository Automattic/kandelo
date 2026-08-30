/* vt100 core — see vt100.h. One TU: grid + parser + UTF-8 + render + input.
 * Adapted from docs/plans/2026-07-20-wpk-shell-plan.md Phase A pseudocode
 * (grid.c/parser.c/render.c/input.c), folding its review inline-fixes:
 *   - #7: bare '\n' resets cx to 0 (CR+LF) so output doesn't stair-step.
 *   - #9: input CSI arms memcpy fixed-length sequences, bounds-checked.
 */
#include "vt100.h"

#include <stdlib.h>
#include <string.h>

#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

struct cell {
    uint32_t codepoint;   /* UTF-32; 0 = blank */
    uint8_t fg, bg;       /* 0-15 ANSI palette, 16 = default */
    uint8_t flags;        /* bit0 = bold, bit1 = reverse */
    uint8_t _pad;
};

struct vt100 {
    int cols, rows;
    struct cell *grid;    /* cols × rows */
    int cx, cy;           /* cursor */
    uint8_t fg, bg, flags;
    uint8_t *dirty;       /* one bit per row */
    enum { GROUND, ESCAPE, CSI } state;
    char csi_buf[32];
    int csi_used;
};

/* ---- grid -------------------------------------------------------------- */

void vt100_mark_dirty_all(struct vt100 *t) {
    for (int i = 0; i < (t->rows + 7) / 8; i++) t->dirty[i] = 0xff;
}

static void mark_dirty(struct vt100 *t, int row) {
    if (row >= 0 && row < t->rows) t->dirty[row / 8] |= 1u << (row % 8);
}

struct vt100 *vt100_create(int cols, int rows) {
    if (cols < 4 || cols > 512 || rows < 4 || rows > 256) return NULL;
    struct vt100 *t = calloc(1, sizeof *t);
    if (!t) return NULL;
    t->cols = cols;
    t->rows = rows;
    t->grid = calloc((size_t)cols * rows, sizeof(struct cell));
    t->dirty = calloc((rows + 7) / 8, 1);
    if (!t->grid || !t->dirty) {
        vt100_destroy(t);
        return NULL;
    }
    t->fg = 7;   /* light grey */
    t->bg = 16;  /* default */
    vt100_mark_dirty_all(t);
    return t;
}

void vt100_destroy(struct vt100 *t) {
    if (!t) return;
    free(t->dirty);
    free(t->grid);
    free(t);
}

static void scroll_up(struct vt100 *t) {
    memmove(&t->grid[0], &t->grid[t->cols],
            (size_t)(t->rows - 1) * t->cols * sizeof(struct cell));
    memset(&t->grid[(t->rows - 1) * t->cols], 0,
           (size_t)t->cols * sizeof(struct cell));
    for (int x = 0; x < t->cols; x++) {
        t->grid[(t->rows - 1) * t->cols + x].fg = t->fg;
        t->grid[(t->rows - 1) * t->cols + x].bg = t->bg;
    }
    vt100_mark_dirty_all(t);
}

/* ---- parser ------------------------------------------------------------ */

static void put_char(struct vt100 *t, uint32_t codepoint) {
    if (t->cx >= t->cols) {
        t->cx = 0;
        if (++t->cy >= t->rows) { scroll_up(t); t->cy = t->rows - 1; }
    }
    struct cell *c = &t->grid[t->cy * t->cols + t->cx];
    c->codepoint = codepoint;
    c->fg = t->fg;
    c->bg = t->bg;
    c->flags = t->flags;
    mark_dirty(t, t->cy);
    t->cx++;
}

static void apply_csi(struct vt100 *t, char final) {
    int params[16] = {0};
    int n_params = 0;
    const char *p = t->csi_buf;
    while (*p && n_params < 16) {
        params[n_params++] = (int)strtol(p, (char **)&p, 10);
        if (*p == ';') p++;
    }
    switch (final) {
    case 'A': t->cy -= params[0] ? params[0] : 1; break;
    case 'B': t->cy += params[0] ? params[0] : 1; break;
    case 'C': t->cx += params[0] ? params[0] : 1; break;
    case 'D': t->cx -= params[0] ? params[0] : 1; break;
    case 'H':
    case 'f': {
        int r = params[0] ? params[0] - 1 : 0;
        int c = n_params > 1 && params[1] ? params[1] - 1 : 0;
        t->cy = r;
        t->cx = c;
        break;
    }
    case 'J': {
        int mode = params[0];
        if (mode == 2) {
            memset(t->grid, 0, (size_t)t->cols * t->rows * sizeof(struct cell));
            vt100_mark_dirty_all(t);
        } else if (mode == 0) {
            int start = t->cy * t->cols + t->cx;
            memset(&t->grid[start], 0,
                   ((size_t)t->cols * t->rows - start) * sizeof(struct cell));
            for (int r = t->cy; r < t->rows; r++) mark_dirty(t, r);
        }
        break;
    }
    case 'K': {
        if (params[0] == 0) {
            for (int x = t->cx; x < t->cols; x++)
                memset(&t->grid[t->cy * t->cols + x], 0, sizeof(struct cell));
            mark_dirty(t, t->cy);
        }
        break;
    }
    case 'm': {
        if (n_params == 0) { t->fg = 7; t->bg = 16; t->flags = 0; break; }
        for (int i = 0; i < n_params; i++) {
            int q = params[i];
            if (q == 0) { t->fg = 7; t->bg = 16; t->flags = 0; }
            else if (q == 1) t->flags |= 1;
            else if (q == 7) t->flags |= 2;
            else if (q == 22) t->flags &= ~1;
            else if (q == 27) t->flags &= ~2;
            else if (q >= 30 && q <= 37) t->fg = q - 30;
            else if (q == 39) t->fg = 7;
            else if (q >= 40 && q <= 47) t->bg = q - 40;
            else if (q == 49) t->bg = 16;
            else if (q >= 90 && q <= 97) t->fg = q - 90 + 8;
            else if (q >= 100 && q <= 107) t->bg = q - 100 + 8;
            /* 256-colour / truecolour params silently dropped in v1. */
        }
        break;
    }
    default:
        break;  /* unknown CSI final — ignore in v1 */
    }
    if (t->cx < 0) t->cx = 0;
    if (t->cx > t->cols - 1) t->cx = t->cols - 1;
    if (t->cy < 0) t->cy = 0;
    if (t->cy > t->rows - 1) t->cy = t->rows - 1;
}

/* Decode one UTF-8 sequence (BMP + astral); malformed → U+FFFD, consume 1. */
static int utf8_decode(const unsigned char *b, size_t len, uint32_t *cp,
                       size_t *consumed) {
    unsigned char b0 = b[0];
    if (b0 < 0x80) { *cp = b0; *consumed = 1; return 1; }
    if ((b0 & 0xe0) == 0xc0 && len >= 2) {
        *cp = ((uint32_t)(b0 & 0x1f) << 6) | (b[1] & 0x3f);
        *consumed = 2;
        return 1;
    }
    if ((b0 & 0xf0) == 0xe0 && len >= 3) {
        *cp = ((uint32_t)(b0 & 0x0f) << 12) | ((uint32_t)(b[1] & 0x3f) << 6) |
              (b[2] & 0x3f);
        *consumed = 3;
        return 1;
    }
    if ((b0 & 0xf8) == 0xf0 && len >= 4) {
        *cp = ((uint32_t)(b0 & 0x07) << 18) | ((uint32_t)(b[1] & 0x3f) << 12) |
              ((uint32_t)(b[2] & 0x3f) << 6) | (b[3] & 0x3f);
        *consumed = 4;
        return 1;
    }
    *cp = 0xFFFD;
    *consumed = 1;
    return 0;
}

void vt100_feed(struct vt100 *t, const char *bytes, size_t len) {
    for (size_t i = 0; i < len;) {
        unsigned char b = (unsigned char)bytes[i];
        switch (t->state) {
        case GROUND:
            if (b == 0x1b) { t->state = ESCAPE; i++; }
            else if (b == '\r') { t->cx = 0; i++; }
            else if (b == '\n') {
                /* inline-fix #7: treat LF as CR+LF (cooked-ish output). */
                t->cx = 0;
                if (++t->cy >= t->rows) { scroll_up(t); t->cy = t->rows - 1; }
                i++;
            }
            else if (b == '\b') { if (t->cx > 0) t->cx--; i++; }
            else if (b == '\t') { t->cx = (t->cx + 8) & ~7; if (t->cx > t->cols - 1) t->cx = t->cols - 1; i++; }
            else if (b == 0x07) { i++; }  /* BEL — ignored in v1 */
            else if (b >= 0x20) {
                uint32_t cp;
                size_t used;
                utf8_decode((const unsigned char *)bytes + i, len - i, &cp, &used);
                put_char(t, cp);
                i += used;
            }
            else i++;  /* other C0 control — skip */
            break;
        case ESCAPE:
            if (b == '[') { t->state = CSI; t->csi_used = 0; }
            else t->state = GROUND;  /* unknown 2-byte escape — drop */
            i++;
            break;
        case CSI:
            if (b >= 0x40 && b <= 0x7e) {
                t->csi_buf[t->csi_used] = 0;
                apply_csi(t, (char)b);
                t->state = GROUND;
            } else if (t->csi_used < (int)sizeof t->csi_buf - 1) {
                t->csi_buf[t->csi_used++] = (char)b;
            }
            i++;
            break;
        }
    }
}

/* ---- render ------------------------------------------------------------ */

/* ANSI 16-colour palette + index 16 = default (black background). */
static const uint8_t palette[17][3] = {
    {  0,   0,   0}, {170,   0,   0}, {  0, 170,   0}, {170,  85,   0},
    {  0,   0, 170}, {170,   0, 170}, {  0, 170, 170}, {170, 170, 170},
    { 85,  85,  85}, {255,  85,  85}, { 85, 255,  85}, {255, 255,  85},
    { 85,  85, 255}, {255,  85, 255}, { 85, 255, 255}, {255, 255, 255},
    {  0,   0,   0},
};

static int encode_utf8(uint32_t cp, char *out) {
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) {
        out[0] = (char)(0xc0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3f));
        return 2;
    }
    if (cp < 0x10000) {
        out[0] = (char)(0xe0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[2] = (char)(0x80 | (cp & 0x3f));
        return 3;
    }
    out[0] = (char)(0xf0 | (cp >> 18));
    out[1] = (char)(0x80 | ((cp >> 12) & 0x3f));
    out[2] = (char)(0x80 | ((cp >> 6) & 0x3f));
    out[3] = (char)(0x80 | (cp & 0x3f));
    return 4;
}

void vt100_render(struct vt100 *t, struct wpk_surface *s, struct wpk_font *f,
                  int x, int y) {
    /* Inconsolata is monospace; use a representative glyph's advance. */
    int cell_w = wpk_text_width(f, "M");
    int cell_h = wpk_font_height_px(f);
    int ascent = wpk_font_ascent_px(f);
    if (cell_w <= 0) cell_w = 1;
    if (cell_h <= 0) cell_h = 1;

    for (int row = 0; row < t->rows; row++) {
        if (!(t->dirty[row / 8] & (1u << (row % 8)))) continue;
        t->dirty[row / 8] &= ~(1u << (row % 8));
        for (int col = 0; col < t->cols; col++) {
            struct cell *c = &t->grid[row * t->cols + col];
            int px = x + col * cell_w;
            int py = y + row * cell_h;
            uint8_t fg = c->fg <= 16 ? c->fg : 7;
            uint8_t bg = c->bg <= 16 ? c->bg : 16;
            if (c->flags & 2) { uint8_t tmp = fg; fg = bg; bg = tmp; }
            wpk_rect(s, px, py, cell_w, cell_h,
                     WPK_RGB(palette[bg][0], palette[bg][1], palette[bg][2]));
            if (c->codepoint && c->codepoint != ' ') {
                char utf8[5];
                int n = encode_utf8(c->codepoint, utf8);
                utf8[n] = 0;
                wpk_text(s, f, px, py + ascent, utf8,
                         WPK_RGB(palette[fg][0], palette[fg][1], palette[fg][2]));
            }
        }
    }
    /* Cursor: a thin underline in the current cell. */
    int cx_px = x + t->cx * cell_w;
    int cy_px = y + (t->cy + 1) * cell_h - 2;
    wpk_rect(s, cx_px, cy_px, cell_w, 2, WPK_RGB(220, 220, 220));
}

/* ---- input ------------------------------------------------------------- */

/* xkb keysyms (from <xkbcommon/xkbcommon-keysyms.h>) — inlined so vt100
 * stays dependency-free of xkbcommon. */
#define XKB_KEY_Return    0xff0d
#define XKB_KEY_BackSpace 0xff08
#define XKB_KEY_Tab       0xff09
#define XKB_KEY_Escape    0xff1b
#define XKB_KEY_Left      0xff51
#define XKB_KEY_Up        0xff52
#define XKB_KEY_Right     0xff53
#define XKB_KEY_Down      0xff54
#define XKB_KEY_Home      0xff50
#define XKB_KEY_End       0xff57
#define XKB_KEY_Page_Up   0xff55
#define XKB_KEY_Page_Down 0xff56
#define XKB_KEY_Delete    0xffff

static size_t emit(char *out, size_t out_cap, const char *seq, size_t n) {
    if (out_cap < n) return 0;
    memcpy(out, seq, n);
    return n;
}

size_t vt100_input_key(uint32_t keysym, uint32_t mods, char *out, size_t out_cap) {
    /* Ctrl + letter → control code. */
    if ((mods & VT100_MOD_CTRL) && keysym >= 'a' && keysym <= 'z') {
        if (out_cap < 1) return 0;
        out[0] = (char)(keysym - 'a' + 1);
        return 1;
    }
    switch (keysym) {
    case XKB_KEY_Return:    return emit(out, out_cap, "\r", 1);
    case XKB_KEY_BackSpace: return emit(out, out_cap, "\x7f", 1);
    case XKB_KEY_Tab:       return emit(out, out_cap, "\t", 1);
    case XKB_KEY_Escape:    return emit(out, out_cap, "\x1b", 1);
    case XKB_KEY_Left:      return emit(out, out_cap, "\x1b[D", 3);
    case XKB_KEY_Right:     return emit(out, out_cap, "\x1b[C", 3);
    case XKB_KEY_Up:        return emit(out, out_cap, "\x1b[A", 3);
    case XKB_KEY_Down:      return emit(out, out_cap, "\x1b[B", 3);
    case XKB_KEY_Home:      return emit(out, out_cap, "\x1b[H", 3);
    case XKB_KEY_End:       return emit(out, out_cap, "\x1b[F", 3);
    case XKB_KEY_Page_Up:   return emit(out, out_cap, "\x1b[5~", 4);
    case XKB_KEY_Page_Down: return emit(out, out_cap, "\x1b[6~", 4);
    case XKB_KEY_Delete:    return emit(out, out_cap, "\x1b[3~", 4);
    default: break;
    }
    /* Printable keysym → its UTF-8 encoding (xkb returns the codepoint). */
    if (keysym >= 0x20 && keysym <= 0x10ffff) {
        char buf[4];
        int n = encode_utf8(keysym, buf);
        return emit(out, out_cap, buf, (size_t)n);
    }
    return 0;
}

/* ---- test/marker helper ------------------------------------------------ */

int vt100_contains(const struct vt100 *t, const char *needle) {
    size_t nl = strlen(needle);
    if (nl == 0) return 1;
    char *line = malloc((size_t)t->cols + 1);
    if (!line) return 0;
    int found = 0;
    for (int row = 0; row < t->rows && !found; row++) {
        int len = 0;
        for (int col = 0; col < t->cols; col++) {
            uint32_t cp = t->grid[row * t->cols + col].codepoint;
            line[len++] = (cp >= 0x20 && cp <= 0x7e) ? (char)cp : ' ';
        }
        line[len] = 0;
        if (strstr(line, needle)) found = 1;
    }
    free(line);
    return found;
}
