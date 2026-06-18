/*
 * programs/sdl2/editor.c — gap-buffer text editor implementation.
 *
 * Buffer layout:
 *
 *   +------------------+~~~~~~~~~~~~+------------------+
 *   |   pre  (gs)      |   gap      |  post (cap - ge) |
 *   +------------------+~~~~~~~~~~~~+------------------+
 *   0                  gs           ge                 cap
 *
 *   logical length = gs + (cap - ge)
 *   cursor         = gs   (the gap is always at the cursor)
 *
 * Every move_left/right shifts one byte across the gap so the cursor
 * stays at the gap-start; insert/delete then act in O(1). This is the
 * classic gap-buffer behavior — fine for a one-file editor with at
 * most a few thousand bytes of shader source.
 *
 * Line table: we don't pre-index lines. Walking the buffer to find
 * the line at a given offset is O(n) and runs once per render frame;
 * for a 4 KB shader that's ~200 µs worst case, well below the budget.
 * If we ever need bigger files we can lazily cache line starts.
 */

#include "editor.h"
#include "renderer.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define INITIAL_CAP    4096
#define MIN_GAP_BYTES   128
#define TAB_WIDTH         4
#define MAX_LINE_BYTES 1024

static char  *g_buf = NULL;
static size_t g_cap = 0;
static size_t g_gs  = 0;
static size_t g_ge  = 0;
static int    g_top_line = 0;
/* Desired column when moving vertically — preserves "horizontal
 * memory" across short lines like every other editor. Reset on
 * insert/delete and on horizontal navigation. */
static int    g_desired_col = -1;

static inline size_t logical_length(void) {
    return g_gs + (g_cap - g_ge);
}

/* Read the byte at logical index `idx`. Assumes idx < length(). */
static inline unsigned char char_at(size_t idx) {
    if (idx < g_gs) return (unsigned char) g_buf[idx];
    return (unsigned char) g_buf[idx - g_gs + g_ge];
}

/* Grow the buffer if the gap is empty (gs == ge). Doubles capacity
 * and shifts the post-gap region to the new end. Idempotent if the
 * gap already has slack. */
static void ensure_gap(size_t need) {
    if (g_ge - g_gs >= need) return;
    size_t length = logical_length();
    size_t new_cap = g_cap ? g_cap * 2 : INITIAL_CAP;
    while (new_cap - length < need + MIN_GAP_BYTES) new_cap *= 2;
    char *new_buf = (char *) malloc(new_cap);
    if (!new_buf) {
        fprintf(stderr, "FAIL: editor: malloc(%zu) failed\n", new_cap);
        abort();
    }
    size_t post_len = g_cap - g_ge;
    if (g_buf) {
        memcpy(new_buf, g_buf, g_gs);
        memcpy(new_buf + new_cap - post_len, g_buf + g_ge, post_len);
        free(g_buf);
    }
    g_buf = new_buf;
    g_ge  = new_cap - post_len;
    g_cap = new_cap;
}

void editor_init(const char *initial_text) {
    g_cap = INITIAL_CAP;
    g_buf = (char *) malloc(g_cap);
    if (!g_buf) {
        fprintf(stderr, "FAIL: editor: initial malloc failed\n");
        abort();
    }
    g_gs = 0;
    g_ge = g_cap;
    g_top_line = 0;
    g_desired_col = -1;
    if (initial_text && *initial_text) {
        size_t n = strlen(initial_text);
        ensure_gap(n);
        memcpy(g_buf + g_gs, initial_text, n);
        g_gs += n;
    }
    /* Cursor at start. Move the gap there so the user can type at
     * the top of the file. */
    while (g_gs > 0) {
        g_gs--;
        g_ge--;
        g_buf[g_ge] = g_buf[g_gs];
    }
    fprintf(stdout, "sdl2: editor loaded %zu chars\n", logical_length());
}

void editor_shutdown(void) {
    free(g_buf);
    g_buf = NULL;
    g_cap = g_gs = g_ge = 0;
}

/* ----- insertions ------------------------------------------------ */

void editor_insert_char(char c) {
    ensure_gap(1);
    g_buf[g_gs++] = c;
    g_desired_col = -1;
}

void editor_insert_text(const char *s, size_t n) {
    if (!n) return;
    ensure_gap(n);
    memcpy(g_buf + g_gs, s, n);
    g_gs += n;
    g_desired_col = -1;
}

void editor_insert_newline(void) {
    editor_insert_char('\n');
}

void editor_insert_tab(void) {
    /* 4-space soft tab. Indentation-aware tabbing is Phase 8. */
    static const char spaces[TAB_WIDTH] = {' ', ' ', ' ', ' '};
    editor_insert_text(spaces, TAB_WIDTH);
}

/* ----- deletions ------------------------------------------------- */

void editor_delete_back(void) {
    if (g_gs == 0) return;
    g_gs--;
    g_desired_col = -1;
}

void editor_delete_forward(void) {
    if (g_ge == g_cap) return;
    g_ge++;
    g_desired_col = -1;
}

/* ----- movement -------------------------------------------------- */

void editor_move_left(void) {
    if (g_gs == 0) return;
    g_gs--;
    g_ge--;
    g_buf[g_ge] = g_buf[g_gs];
    g_desired_col = -1;
}

void editor_move_right(void) {
    if (g_ge == g_cap) return;
    g_buf[g_gs] = g_buf[g_ge];
    g_gs++;
    g_ge++;
    g_desired_col = -1;
}

/* Move the gap (cursor) to a specific logical offset. O(distance). */
static void move_to_offset(size_t target) {
    size_t len = logical_length();
    if (target > len) target = len;
    while (g_gs > target) editor_move_left();
    while (g_gs < target) editor_move_right();
}

/* Returns the logical offset of the start of the line containing
 * `pos`. The start of the first line is 0; subsequent line starts
 * follow a '\n'. */
static size_t line_start_of(size_t pos) {
    if (pos == 0) return 0;
    size_t i = pos;
    while (i > 0) {
        if (char_at(i - 1) == '\n') return i;
        i--;
    }
    return 0;
}

/* Returns the logical offset of the '\n' that terminates the line
 * containing `pos`, or logical_length() if the line is unterminated. */
static size_t line_end_of(size_t pos) {
    size_t len = logical_length();
    size_t i = pos;
    while (i < len && char_at(i) != '\n') i++;
    return i;
}

static int current_col(void) {
    return (int)(g_gs - line_start_of(g_gs));
}

void editor_move_home(void) {
    size_t ls = line_start_of(g_gs);
    move_to_offset(ls);
    g_desired_col = -1;
}

void editor_move_end(void) {
    size_t le = line_end_of(g_gs);
    move_to_offset(le);
    g_desired_col = -1;
}

static void move_vertical(int direction) {
    /* direction = -1 (up) or +1 (down). Computes the desired column
     * from the current position the first time we move vertically,
     * then preserves it across subsequent vertical moves so a long
     * line doesn't lose horizontal position when transiting through
     * short lines. */
    int col = g_desired_col >= 0 ? g_desired_col : current_col();
    g_desired_col = col;
    size_t cur_ls = line_start_of(g_gs);
    if (direction < 0) {
        if (cur_ls == 0) return;
        size_t prev_ls = line_start_of(cur_ls - 1);
        size_t prev_le = cur_ls - 1;
        int prev_len = (int)(prev_le - prev_ls);
        int target_col = col < prev_len ? col : prev_len;
        move_to_offset(prev_ls + (size_t) target_col);
    } else {
        size_t len = logical_length();
        size_t cur_le = line_end_of(g_gs);
        if (cur_le >= len) return;
        size_t next_ls = cur_le + 1;
        size_t next_le = line_end_of(next_ls);
        int next_len = (int)(next_le - next_ls);
        int target_col = col < next_len ? col : next_len;
        move_to_offset(next_ls + (size_t) target_col);
    }
}

void editor_move_up(void)    { move_vertical(-1); }
void editor_move_down(void)  { move_vertical(+1); }

void editor_move_page_up(int visible_lines) {
    int n = visible_lines > 1 ? visible_lines - 1 : 1;
    for (int i = 0; i < n; i++) move_vertical(-1);
}

void editor_move_page_down(int visible_lines) {
    int n = visible_lines > 1 ? visible_lines - 1 : 1;
    for (int i = 0; i < n; i++) move_vertical(+1);
}

/* ----- inspection ------------------------------------------------ */

size_t editor_text_length(void)   { return logical_length(); }
size_t editor_cursor_offset(void) { return g_gs; }
int    editor_cursor_col(void)    { return current_col(); }

int editor_cursor_line(void) {
    int line = 0;
    for (size_t i = 0; i < g_gs; i++) {
        if (char_at(i) == '\n') line++;
    }
    return line;
}

int editor_line_count(void) {
    int lines = 1;
    size_t len = logical_length();
    for (size_t i = 0; i < len; i++) {
        if (char_at(i) == '\n') lines++;
    }
    return lines;
}

char *editor_dup_text(void) {
    size_t len = logical_length();
    char *out = (char *) malloc(len + 1);
    if (!out) return NULL;
    memcpy(out,             g_buf,             g_gs);
    memcpy(out + g_gs,      g_buf + g_ge,      g_cap - g_ge);
    out[len] = '\0';
    return out;
}

/* ----- render ---------------------------------------------------- */

static const float COLOR_BG_R = 0.10f;
static const float COLOR_BG_G = 0.10f;
static const float COLOR_BG_B = 0.13f;
static const float GUTTER_BG_R = 0.13f;
static const float GUTTER_BG_G = 0.13f;
static const float GUTTER_BG_B = 0.17f;
static const float GUTTER_FG_R = 0.45f;
static const float GUTTER_FG_G = 0.45f;
static const float GUTTER_FG_B = 0.50f;
static const float TEXT_R      = 0.88f;
static const float TEXT_G      = 0.88f;
static const float TEXT_B      = 0.92f;
static const float CURSOR_R    = 1.00f;
static const float CURSOR_G    = 0.88f;
static const float CURSOR_B    = 0.55f;
static const int   GUTTER_PAD  = 6;
static const int   GUTTER_DIGITS = 4;  /* line numbers up to 9999 */
/* Vertical breathing room above the first line so it isn't flush
 * against the pane's top border. Applied consistently by the layout,
 * the renderer, and the click hit-test. */
static const int   EDITOR_TOP_PAD = 8;

/* Shared layout computation — both `editor_render` and
 * `editor_pointer_set_cursor` need the same gutter / text origin so a
 * click lands where the glyph was drawn. */
typedef struct {
    int line_h;
    int advance;
    int gutter_w;
    int text_x;
    int text_w;
    int visible_lines;
} EditorLayout;

static int compute_layout(int x, int w, int h, EditorLayout *out) {
    int line_h  = renderer_text_line_height();
    int advance = renderer_text_advance();
    if (line_h <= 0 || advance <= 0) return 0;
    int gutter_w = advance * GUTTER_DIGITS + GUTTER_PAD * 2;
    if (gutter_w > w / 2) gutter_w = w / 2;
    int text_x = x + gutter_w + GUTTER_PAD;
    int text_w = w - (text_x - x);
    int visible_lines = (h - EDITOR_TOP_PAD) / line_h;
    if (visible_lines < 1) visible_lines = 1;
    out->line_h        = line_h;
    out->advance       = advance;
    out->gutter_w      = gutter_w;
    out->text_x        = text_x;
    out->text_w        = text_w;
    out->visible_lines = visible_lines;
    return 1;
}

/* Walk the buffer and return the byte length of `line` (0-indexed),
 * along with its starting offset. Returns -1 if `line` is past the
 * end. */
static int line_extent(int line, size_t *out_start, size_t *out_len) {
    size_t len = logical_length();
    size_t pos = 0;
    int idx = 0;
    while (idx < line) {
        if (pos >= len) return -1;
        if (char_at(pos) == '\n') idx++;
        pos++;
    }
    size_t start = pos;
    while (pos < len && char_at(pos) != '\n') pos++;
    *out_start = start;
    *out_len = pos - start;
    return 0;
}

void editor_pointer_set_cursor(int px, int py,
                               int x, int y, int w, int h) {
    EditorLayout L;
    if (!compute_layout(x, w, h, &L)) return;
    /* Reject clicks outside the editor pane outright. */
    if (px < x || px >= x + w || py < y || py >= y + h) return;

    int row = (py - y - EDITOR_TOP_PAD) / L.line_h;
    if (row < 0) row = 0;
    if (row >= L.visible_lines) row = L.visible_lines - 1;
    int target_line = g_top_line + row;
    int total_lines = editor_line_count();
    if (target_line >= total_lines) target_line = total_lines - 1;
    if (target_line < 0) target_line = 0;

    /* Column: clicks left of the text origin (gutter) land at column 0. */
    int col_px = px - L.text_x;
    int target_col = col_px < 0 ? 0 : col_px / L.advance;

    size_t line_start = 0, line_len = 0;
    if (line_extent(target_line, &line_start, &line_len) != 0) return;
    if ((size_t) target_col > line_len) target_col = (int) line_len;
    move_to_offset(line_start + (size_t) target_col);
    g_desired_col = -1;
}

void editor_render(int x, int y, int w, int h,
                   unsigned int now_ms, int has_focus) {
    if (w <= 0 || h <= 0) return;

    EditorLayout L;
    if (!compute_layout(x, w, h, &L)) return;
    int line_h        = L.line_h;
    int advance       = L.advance;
    int gutter_w      = L.gutter_w;
    int text_x        = L.text_x;
    int text_w        = L.text_w;
    int visible_lines = L.visible_lines;

    /* Scroll-into-view: if the cursor's line is outside the current
     * window of `visible_lines` starting at g_top_line, scroll. */
    int cur_line = editor_cursor_line();
    if (cur_line < g_top_line) g_top_line = cur_line;
    if (cur_line >= g_top_line + visible_lines) {
        g_top_line = cur_line - visible_lines + 1;
    }
    if (g_top_line < 0) g_top_line = 0;

    /* Background fills (one solid quad each). */
    renderer_fill_rect(x, y, w, h,
                       COLOR_BG_R, COLOR_BG_G, COLOR_BG_B, 1.0f);
    renderer_fill_rect(x, y, gutter_w, h,
                       GUTTER_BG_R, GUTTER_BG_G, GUTTER_BG_B, 1.0f);

    /* Walk to the start of g_top_line. */
    size_t len = logical_length();
    size_t pos = 0;
    int    line_idx = 0;
    while (pos < len && line_idx < g_top_line) {
        if (char_at(pos) == '\n') line_idx++;
        pos++;
    }

    /* Visible cursor blink: ON for 600 ms, OFF for 400 ms. Off when
     * unfocused. */
    int cursor_visible = has_focus && (((now_ms / 100) % 10) < 6);

    int total_lines = editor_line_count();
    char line_buf[MAX_LINE_BYTES];
    char gutter_buf[16];
    int line_y = y + EDITOR_TOP_PAD;
    for (int row = 0;
         row < visible_lines && g_top_line + row < total_lines;
         row++) {
        /* Extract this line into line_buf. */
        size_t k = 0;
        while (pos < len) {
            unsigned char c = char_at(pos);
            pos++;
            if (c == '\n') break;
            if (k < sizeof line_buf - 1) line_buf[k++] = (char) c;
        }
        line_buf[k] = '\0';

        /* Gutter line number — right-aligned in the gutter. 1-indexed
         * for human-readable display. */
        int displayed = g_top_line + row + 1;
        snprintf(gutter_buf, sizeof gutter_buf, "%4d", displayed);
        renderer_draw_textz(x + GUTTER_PAD, line_y, gutter_buf,
                            GUTTER_FG_R, GUTTER_FG_G, GUTTER_FG_B);

        /* Source text. Truncate to the visible width. */
        int max_cols = text_w / advance;
        if (max_cols < 0) max_cols = 0;
        size_t draw_n = k <= (size_t) max_cols ? k : (size_t) max_cols;
        renderer_draw_text(text_x, line_y, line_buf, draw_n,
                           TEXT_R, TEXT_G, TEXT_B);

        /* Cursor — draw on top if it's on this row. */
        if (cursor_visible) {
            int this_line = g_top_line + row;
            if (cur_line == this_line) {
                int col = editor_cursor_col();
                int cx = text_x + col * advance;
                int cy = line_y;
                int cw = has_focus ? 2 : 1;
                int ch = line_h - 2;
                renderer_fill_rect(cx, cy, cw, ch,
                                   CURSOR_R, CURSOR_G, CURSOR_B,
                                   has_focus ? 0.95f : 0.55f);
            }
        }

        line_y += line_h;
    }
}
