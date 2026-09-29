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
    /* CSI parameters, accumulated byte by byte as the sequence arrives
     * (so a sequence split across reads needs no buffer). csi_n counts
     * fields seen so far: 0 until the first digit or ';'. Values saturate
     * at CSI_PARAM_MAX and fields past CSI_MAX_PARAMS are dropped, so no
     * input can overflow them. csi_ignore marks a well-formed sequence
     * this terminal does not implement (private marker, intermediate byte,
     * ':' sub-parameter); it is consumed through its final byte and
     * dropped, never misread as a public sequence. */
    int csi_params[16];
    int csi_n;
    int csi_ignore;
    /* A UTF-8 sequence split across two reads. wlterm feeds the PTY in
     * fixed 4096-byte chunks, so without this a multi-byte character
     * straddling a chunk boundary decoded as several U+FFFD. */
    unsigned char u8_buf[4];
    int u8_used;
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

int vt100_resize(struct vt100 *t, int cols, int rows) {
    if (cols < 4 || cols > 512 || rows < 4 || rows > 256) return 0;
    if (cols == t->cols && rows == t->rows) return 0;

    struct cell *grid = calloc((size_t)cols * rows, sizeof(struct cell));
    uint8_t *dirty = calloc((rows + 7) / 8, 1);
    if (!grid || !dirty) { free(grid); free(dirty); return 0; }

    /* Preserve the overlapping top-left block so visible output survives a
     * retile. */
    int cpy_rows = rows < t->rows ? rows : t->rows;
    int cpy_cols = cols < t->cols ? cols : t->cols;
    for (int y = 0; y < cpy_rows; y++)
        memcpy(&grid[(size_t)y * cols], &t->grid[(size_t)y * t->cols],
               (size_t)cpy_cols * sizeof(struct cell));

    free(t->grid);
    free(t->dirty);
    t->grid = grid;
    t->dirty = dirty;
    t->cols = cols;
    t->rows = rows;
    if (t->cx >= cols) t->cx = cols - 1;
    if (t->cy >= rows) t->cy = rows - 1;
    vt100_mark_dirty_all(t);
    return 1;
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

#define CSI_MAX_PARAMS ((int)(sizeof ((struct vt100 *)0)->csi_params / sizeof(int)))
#define CSI_PARAM_MAX 65535

/* Blank cells [from, to) of the grid, in row-major order, with the current
 * colours (as scroll_up fills the new bottom row), and mark their rows. */
static void erase_cells(struct vt100 *t, int from, int to) {
    for (int i = from; i < to; i++) {
        t->grid[i].codepoint = 0;
        t->grid[i].fg = t->fg;
        t->grid[i].bg = t->bg;
        t->grid[i].flags = 0;
    }
    if (from < to)
        for (int r = from / t->cols; r <= (to - 1) / t->cols; r++) mark_dirty(t, r);
}

/* Clamp the cursor into the grid. Cursor movement and erasure call this,
 * which also ends a pending wrap (cx == cols), as Linux's csi_J/csi_K and
 * cursor commands clear vc_need_wrap; SGR and ignored finals must not, or
 * a coloured full-width line would lose its wrap. */
static void clamp_cursor(struct vt100 *t) {
    if (t->cx < 0) t->cx = 0;
    if (t->cx > t->cols - 1) t->cx = t->cols - 1;
    if (t->cy < 0) t->cy = 0;
    if (t->cy > t->rows - 1) t->cy = t->rows - 1;
}

static void apply_csi(struct vt100 *t, char final) {
    const int *params = t->csi_params;
    int n_params = t->csi_n < CSI_MAX_PARAMS ? t->csi_n : CSI_MAX_PARAMS;
    /* put_char leaves cx == cols after writing the last column (wrap
     * pending); erasures act on the cell the cursor occupies. */
    int col = t->cx < t->cols ? t->cx : t->cols - 1;
    int row = t->cy * t->cols;
    int end = t->rows * t->cols;
    switch (final) {
    case 'A': t->cy -= params[0] ? params[0] : 1; clamp_cursor(t); break;
    case 'B': t->cy += params[0] ? params[0] : 1; clamp_cursor(t); break;
    case 'C': t->cx += params[0] ? params[0] : 1; clamp_cursor(t); break;
    case 'D': t->cx -= params[0] ? params[0] : 1; clamp_cursor(t); break;
    case 'H':
    case 'f': {
        int r = params[0] ? params[0] - 1 : 0;
        int c = n_params > 1 && params[1] ? params[1] - 1 : 0;
        t->cy = r;
        t->cx = c;
        clamp_cursor(t);
        break;
    }
    case 'J':   /* ED: 0 cursor..end, 1 start..cursor, 2 whole screen */
        if (params[0] == 0) erase_cells(t, row + col, end);
        else if (params[0] == 1) erase_cells(t, 0, row + col + 1);
        /* 3 also drops scrollback on Linux; there is none to drop here. */
        else if (params[0] == 2 || params[0] == 3) erase_cells(t, 0, end);
        clamp_cursor(t);
        break;
    case 'K':   /* EL: 0 cursor..end of line, 1 line start..cursor, 2 line */
        if (params[0] == 0) erase_cells(t, row + col, row + t->cols);
        else if (params[0] == 1) erase_cells(t, row, row + col + 1);
        else if (params[0] == 2) erase_cells(t, row, row + t->cols);
        clamp_cursor(t);
        break;
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
}

/* Length a UTF-8 lead byte announces, or 0 if it is not a valid lead. */
static size_t utf8_seq_len(unsigned char b0) {
    if (b0 < 0x80) return 1;
    if ((b0 & 0xe0) == 0xc0) return 2;
    if ((b0 & 0xf0) == 0xe0) return 3;
    if ((b0 & 0xf8) == 0xf0) return 4;
    return 0;
}

/* 1 if b is a UTF-8 continuation byte (10xxxxxx). */
static int utf8_is_cont(unsigned char b) { return (b & 0xc0) == 0x80; }

/* Decode one UTF-8 sequence (BMP + astral); malformed → U+FFFD, consume 1. */
static int utf8_decode(const unsigned char *b, size_t len, uint32_t *cp,
                       size_t *consumed) {
    unsigned char b0 = b[0];
    if (b0 < 0x80) { *cp = b0; *consumed = 1; return 1; }
    size_t need = utf8_seq_len(b0);
    if (need >= 2 && len >= need) {
        /* A truncated sequence must not swallow the byte that follows it:
         * "\xc3A" is U+FFFD then 'A', not U+00C1. */
        for (size_t k = 1; k < need; k++) {
            if (!utf8_is_cont(b[k])) {
                *cp = 0xFFFD;
                *consumed = 1;
                return 0;
            }
        }
        if (need == 2) {
            *cp = ((uint32_t)(b0 & 0x1f) << 6) | (b[1] & 0x3f);
        } else if (need == 3) {
            *cp = ((uint32_t)(b0 & 0x0f) << 12) |
                  ((uint32_t)(b[1] & 0x3f) << 6) | (b[2] & 0x3f);
        } else {
            *cp = ((uint32_t)(b0 & 0x07) << 18) |
                  ((uint32_t)(b[1] & 0x3f) << 12) |
                  ((uint32_t)(b[2] & 0x3f) << 6) | (b[3] & 0x3f);
        }
        *consumed = need;
        return 1;
    }
    *cp = 0xFFFD;
    *consumed = 1;
    return 0;
}

/* Execute a C0 control other than ESC. */
static void exec_c0(struct vt100 *t, unsigned char b) {
    if (b == '\r') t->cx = 0;
    else if (b == '\n') {
        /* inline-fix #7: treat LF as CR+LF (cooked-ish output). */
        t->cx = 0;
        if (++t->cy >= t->rows) { scroll_up(t); t->cy = t->rows - 1; }
    }
    else if (b == '\b') { if (t->cx > 0) t->cx--; }
    else if (b == '\t') { t->cx = (t->cx + 8) & ~7; if (t->cx > t->cols - 1) t->cx = t->cols - 1; }
    /* BEL and other C0 controls are ignored in v1. */
}

void vt100_feed(struct vt100 *t, const char *bytes, size_t len) {
    /* Finish a sequence the previous feed left partial.
     *
     * Only continuation bytes (10xxxxxx) may join the stash. The first byte
     * that is not one ends the pending sequence as U+FFFD and is then
     * processed normally below -- so no byte is ever swallowed, whether the
     * break arrives in this feed or several feeds later. (Stashing whatever
     * arrived and validating only once the stash was full lost that byte:
     * "\xf0", "A", "BC" in three feeds used to drop the 'A'.) */
    while (t->u8_used > 0 && len > 0) {
        unsigned char c = (unsigned char)*bytes;
        if (!utf8_is_cont(c)) {
            put_char(t, 0xFFFD);
            t->u8_used = 0;
            break;
        }
        t->u8_buf[t->u8_used++] = c;
        bytes++;
        len--;
        if ((size_t)t->u8_used == utf8_seq_len(t->u8_buf[0])) {
            uint32_t cp;
            size_t used;
            utf8_decode(t->u8_buf, (size_t)t->u8_used, &cp, &used);
            put_char(t, cp);
            t->u8_used = 0;
        }
    }
    for (size_t i = 0; i < len;) {
        unsigned char b = (unsigned char)bytes[i];
        switch (t->state) {
        case GROUND:
            if (b == 0x1b) { t->state = ESCAPE; i++; }
            else if (b >= 0x20) {
                uint32_t cp;
                size_t used;
                size_t avail = len - i;
                size_t need = utf8_seq_len(b);
                /* Lead byte announces more than this read holds. Stash it for
                 * the next feed -- the way the CSI parser carries a split
                 * escape -- but only if everything after it here is a
                 * continuation byte. Otherwise the sequence is already
                 * malformed: fall through, and utf8_decode emits U+FFFD for
                 * the lead byte alone so the rest is processed normally. */
                if (need > 1 && need > avail) {
                    size_t k = 1;
                    while (k < avail && utf8_is_cont((unsigned char)bytes[i + k]))
                        k++;
                    if (k == avail) {
                        t->u8_used = 0;
                        for (size_t j = 0; j < avail; j++)
                            t->u8_buf[t->u8_used++] = (unsigned char)bytes[i + j];
                        i = len;
                        break;
                    }
                }
                utf8_decode((const unsigned char *)bytes + i, avail, &cp, &used);
                put_char(t, cp);
                i += used;
            }
            else { exec_c0(t, b); i++; }
            break;
        case ESCAPE:
            if (b == '[') {
                t->state = CSI;
                memset(t->csi_params, 0, sizeof t->csi_params);
                t->csi_n = 0;
                t->csi_ignore = 0;
            }
            else t->state = GROUND;  /* unknown 2-byte escape — drop */
            i++;
            break;
        case CSI:
            if (b >= '0' && b <= '9') {
                if (t->csi_n == 0) t->csi_n = 1;
                if (t->csi_n <= CSI_MAX_PARAMS) {
                    int *v = &t->csi_params[t->csi_n - 1];
                    *v = *v > (CSI_PARAM_MAX - (b - '0')) / 10
                        ? CSI_PARAM_MAX : *v * 10 + (b - '0');
                }
            } else if (b == ';') {
                if (t->csi_n == 0) t->csi_n = 1;
                if (t->csi_n <= CSI_MAX_PARAMS) t->csi_n++;
            } else if (b >= 0x20 && b <= 0x3f) {
                /* ':' sub-parameter, '<=>?' private marker, or an
                 * intermediate byte: none are implemented. */
                t->csi_ignore = 1;
            } else if (b >= 0x40 && b <= 0x7e) {
                if (!t->csi_ignore) apply_csi(t, (char)b);
                t->state = GROUND;
            } else if (b == 0x1b) {
                t->state = ESCAPE;         /* ESC aborts, starts anew */
            } else if (b == 0x18 || b == 0x1a) {
                t->state = GROUND;         /* CAN / SUB abort */
            } else if (b < 0x20) {
                exec_c0(t, b);             /* C0 controls act mid-sequence */
            }
            /* DEL and bytes >= 0x80 are ignored inside a sequence. */
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

uint32_t vt100_cell(const struct vt100 *t, int row, int col) {
    if (row < 0 || row >= t->rows || col < 0 || col >= t->cols) return 0;
    return t->grid[row * t->cols + col].codepoint;
}

void vt100_cursor(const struct vt100 *t, int *row, int *col) {
    if (row) *row = t->cy;
    if (col) *col = t->cx;
}
