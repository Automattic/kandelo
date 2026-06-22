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
/* Last cursor offset that editor_render scrolled into view. The render's
 * scroll-into-view only re-centers when the cursor has actually moved
 * (typing / navigation), so a wheel scroll (editor_scroll) that pushes the
 * cursor off-screen isn't snapped straight back on the next frame.
 * (size_t)-1 forces a re-center on the first render after init. */
static size_t g_scroll_anchor = (size_t) -1;
/* Desired column when moving vertically — preserves "horizontal
 * memory" across short lines like every other editor. Reset on
 * insert/delete and on horizontal navigation. */
static int    g_desired_col = -1;

/* Selection anchor (logical offset), or NO_SEL when there is no
 * selection. The selected span is [min(anchor,cursor), max(...)). */
#define NO_SEL ((size_t) -1)
static size_t g_sel_anchor = NO_SEL;

/* Error-line marker: 0-indexed editor line the last compile error maps
 * to, or -1 for none. */
static int    g_error_line = -1;

/* ----- undo / redo ring ------------------------------------------ */

#define UNDO_MAX 32
typedef struct { char *text; size_t cursor; } Snapshot;
typedef enum { EK_NONE = 0, EK_INSERT, EK_DELETE } EditKind;

static Snapshot g_undo[UNDO_MAX];
static int      g_undo_n = 0;
static Snapshot g_redo[UNDO_MAX];
static int      g_redo_n = 0;
/* Coalescing: a run of same-kind edits shares one undo step. A cursor
 * move / selection change sets g_undo_break so the next edit opens a new
 * group even if it's the same kind. */
static EditKind g_undo_last_kind = EK_NONE;
static int      g_undo_break = 1;

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

/* (Re)build the gap buffer from `text` with the cursor (gap) at offset
 * `cursor`. Frees any existing buffer. Shared by editor_init and the
 * undo/redo + preset-load restore paths; does NOT log or touch the undo
 * stacks. */
static void build_buffer(const char *text, size_t cursor) {
    free(g_buf);
    g_cap = INITIAL_CAP;
    g_buf = (char *) malloc(g_cap);
    if (!g_buf) {
        fprintf(stderr, "FAIL: editor: initial malloc failed\n");
        abort();
    }
    g_gs = 0;
    g_ge = g_cap;
    g_top_line = 0;
    g_scroll_anchor = (size_t) -1;
    g_desired_col = -1;
    g_sel_anchor = NO_SEL;
    if (text && *text) {
        size_t n = strlen(text);
        ensure_gap(n);
        memcpy(g_buf + g_gs, text, n);
        g_gs += n;
    }
    /* Drag the gap back to `cursor` (clamped). build leaves the gap at
     * end-of-text; walk it left to the requested offset. */
    size_t len = logical_length();
    if (cursor > len) cursor = len;
    while (g_gs > cursor) {
        g_gs--;
        g_ge--;
        g_buf[g_ge] = g_buf[g_gs];
    }
}

void editor_init(const char *initial_text) {
    /* Fresh document: drop any prior undo/redo history. */
    for (int i = 0; i < g_undo_n; i++) free(g_undo[i].text);
    for (int i = 0; i < g_redo_n; i++) free(g_redo[i].text);
    g_undo_n = g_redo_n = 0;
    g_undo_last_kind = EK_NONE;
    g_undo_break = 1;
    g_error_line = -1;

    build_buffer(initial_text, 0);
    fprintf(stdout, "sdl2: editor loaded %zu chars\n", logical_length());
}

void editor_shutdown(void) {
    free(g_buf);
    g_buf = NULL;
    g_cap = g_gs = g_ge = 0;
    for (int i = 0; i < g_undo_n; i++) free(g_undo[i].text);
    for (int i = 0; i < g_redo_n; i++) free(g_redo[i].text);
    g_undo_n = g_redo_n = 0;
    g_sel_anchor = NO_SEL;
}

/* ----- undo / redo ----------------------------------------------- */

static void snapshot_stack_push(Snapshot *stack, int *n, char *text,
                                size_t cursor) {
    if (*n == UNDO_MAX) {
        free(stack[0].text);
        memmove(&stack[0], &stack[1], (UNDO_MAX - 1) * sizeof(Snapshot));
        (*n)--;
    }
    stack[*n].text   = text;
    stack[*n].cursor = cursor;
    (*n)++;
}

static void redo_clear(void) {
    for (int i = 0; i < g_redo_n; i++) free(g_redo[i].text);
    g_redo_n = 0;
}

/* Capture the pre-edit state onto the undo stack, honoring coalescing.
 * Called at the very start of every mutating op (before it changes the
 * buffer or deletes a selection), so an undo restores exactly the state
 * before the group began. */
static void undo_record(EditKind kind) {
    if (g_undo_break || kind != g_undo_last_kind) {
        char *snap = editor_dup_text();
        if (snap) snapshot_stack_push(g_undo, &g_undo_n, snap, g_gs);
        redo_clear();
        g_undo_break = 0;
    }
    g_undo_last_kind = kind;
}

/* End the current coalescing group — the next edit starts a new undo
 * step. Called on cursor moves and selection changes. */
static void undo_break(void) { g_undo_break = 1; }

void editor_undo(void) {
    if (g_undo_n == 0) return;
    char *cur = editor_dup_text();
    if (cur) snapshot_stack_push(g_redo, &g_redo_n, cur, g_gs);
    Snapshot s = g_undo[--g_undo_n];
    build_buffer(s.text, s.cursor);
    free(s.text);
    g_undo_last_kind = EK_NONE;
    g_undo_break = 1;
    g_sel_anchor = NO_SEL;
}

void editor_redo(void) {
    if (g_redo_n == 0) return;
    char *cur = editor_dup_text();
    if (cur) snapshot_stack_push(g_undo, &g_undo_n, cur, g_gs);
    Snapshot s = g_redo[--g_redo_n];
    build_buffer(s.text, s.cursor);
    free(s.text);
    g_undo_last_kind = EK_NONE;
    g_undo_break = 1;
    g_sel_anchor = NO_SEL;
}

void editor_replace_all(const char *text) {
    undo_break();             /* force a fresh snapshot of the pre-state */
    undo_record(EK_INSERT);
    undo_break();             /* and the next edit is its own group too  */
    build_buffer(text ? text : "", 0);
    g_desired_col = -1;
}

void editor_set_error_line(int line0) { g_error_line = line0; }

/* ----- insertions ------------------------------------------------ */

void editor_insert_char(char c) {
    undo_record(EK_INSERT);
    if (editor_has_selection()) editor_delete_selection();
    ensure_gap(1);
    g_buf[g_gs++] = c;
    g_desired_col = -1;
}

void editor_insert_text(const char *s, size_t n) {
    if (!n) return;
    undo_record(EK_INSERT);
    if (editor_has_selection()) editor_delete_selection();
    ensure_gap(n);
    memcpy(g_buf + g_gs, s, n);
    g_gs += n;
    g_desired_col = -1;
}

void editor_insert_newline(void) {
    editor_insert_char('\n');
}

void editor_insert_tab(void) {
    static const char spaces[TAB_WIDTH] = {' ', ' ', ' ', ' '};
    editor_insert_text(spaces, TAB_WIDTH);
}

/* ----- deletions ------------------------------------------------- */

void editor_delete_back(void) {
    if (editor_has_selection()) {
        undo_record(EK_DELETE);
        editor_delete_selection();
        return;
    }
    if (g_gs == 0) return;
    undo_record(EK_DELETE);
    g_gs--;
    g_desired_col = -1;
}

void editor_delete_forward(void) {
    if (editor_has_selection()) {
        undo_record(EK_DELETE);
        editor_delete_selection();
        return;
    }
    if (g_ge == g_cap) return;
    undo_record(EK_DELETE);
    g_ge++;
    g_desired_col = -1;
}

/* ----- movement -------------------------------------------------- */

void editor_move_left(void) {
    undo_break();
    if (g_gs == 0) return;
    g_gs--;
    g_ge--;
    g_buf[g_ge] = g_buf[g_gs];
    g_desired_col = -1;
}

void editor_move_right(void) {
    undo_break();
    if (g_ge == g_cap) return;
    g_buf[g_gs] = g_buf[g_ge];
    g_gs++;
    g_ge++;
    g_desired_col = -1;
}

/* Move the gap (cursor) to a specific logical offset. O(distance). */
static void move_to_offset(size_t target) {
    undo_break();
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
    /* Set the remembered column AFTER the move: move_to_offset runs the
     * horizontal move primitives, which each reset g_desired_col. */
    g_desired_col = col;
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

/* Scroll the viewport by `delta_lines` (negative = toward the top of the
 * file) WITHOUT moving the cursor — the mouse-wheel path. Clamped so the
 * top line can't go past the last line. Because editor_render only
 * re-centers on the cursor when it moves, this scroll position persists
 * until the user navigates or edits. */
void editor_scroll(int delta_lines) {
    int total = editor_line_count();
    g_top_line += delta_lines;
    if (g_top_line > total - 1) g_top_line = total - 1;
    if (g_top_line < 0) g_top_line = 0;
}

/* ----- selection ------------------------------------------------- */

int editor_has_selection(void) {
    return g_sel_anchor != NO_SEL && g_sel_anchor != g_gs;
}

void editor_selection_begin(void) {
    if (g_sel_anchor == NO_SEL) g_sel_anchor = g_gs;
}

void editor_selection_clear(void) {
    g_sel_anchor = NO_SEL;
}

void editor_select_all(void) {
    undo_break();
    g_sel_anchor = 0;
    move_to_offset(logical_length());
    g_desired_col = -1;
}

/* Ordered selection bounds written to *a (lo) and *b (hi). Returns 0,
 * leaving both untouched, when there is no selection. */
static int selection_bounds(size_t *a, size_t *b) {
    if (!editor_has_selection()) return 0;
    size_t lo = g_sel_anchor < g_gs ? g_sel_anchor : g_gs;
    size_t hi = g_sel_anchor < g_gs ? g_gs : g_sel_anchor;
    *a = lo;
    *b = hi;
    return 1;
}

char *editor_selection_dup(void) {
    size_t a, b;
    if (!selection_bounds(&a, &b)) return NULL;
    size_t n = b - a;
    char *out = (char *) malloc(n + 1);
    if (!out) return NULL;
    for (size_t i = 0; i < n; i++) out[i] = (char) char_at(a + i);
    out[n] = '\0';
    return out;
}

/* Raw removal of the selected span — does NOT record undo (the public
 * insert/delete ops call undo_record before invoking this). Cursor lands
 * at the span start; selection is cleared. */
void editor_delete_selection(void) {
    size_t a, b;
    if (!selection_bounds(&a, &b)) return;
    move_to_offset(a);
    size_t count = b - a;
    while (count-- > 0 && g_ge < g_cap) g_ge++;
    g_sel_anchor = NO_SEL;
    g_desired_col = -1;
}

/* ----- inspection ------------------------------------------------ */

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
/* Editor text color now comes from the syntax highlighter (Dracula
 * palette, HL_* below) — see draw_highlighted_line. */
static const float CURSOR_R    = 1.00f;
static const float CURSOR_G    = 0.88f;
static const float CURSOR_B    = 0.55f;
/* Selection highlight (translucent Dracula "selection" #44475a) and the
 * compile-error line tint (translucent red) + its gutter marker color. */
static const float SEL_R       = 0.267f;
static const float SEL_G       = 0.278f;
static const float SEL_B       = 0.353f;
static const float SEL_A       = 0.90f;
static const float ERRLINE_R   = 0.50f;
static const float ERRLINE_G   = 0.12f;
static const float ERRLINE_B   = 0.14f;
static const float ERRLINE_A   = 0.35f;
static const float ERRMARK_R   = 1.00f;
static const float ERRMARK_G   = 0.40f;
static const float ERRMARK_B   = 0.40f;
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

/* Map a window-pixel point to a logical offset using the same layout the
 * frame was drawn with. Returns 0 if the point is outside the pane or the
 * layout is degenerate (caller should ignore), else 1 with *off set. */
static int pointer_to_offset(int px, int py,
                             int x, int y, int w, int h, size_t *off) {
    EditorLayout L;
    if (!compute_layout(x, w, h, &L)) return 0;
    if (px < x || px >= x + w || py < y || py >= y + h) return 0;

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
    if (line_extent(target_line, &line_start, &line_len) != 0) return 0;
    if ((size_t) target_col > line_len) target_col = (int) line_len;
    *off = line_start + (size_t) target_col;
    return 1;
}

void editor_pointer_set_cursor(int px, int py,
                               int x, int y, int w, int h) {
    size_t off;
    if (!pointer_to_offset(px, py, x, y, w, h, &off)) return;
    editor_selection_clear();
    move_to_offset(off);
    g_desired_col = -1;
}

void editor_pointer_extend_select(int px, int py,
                                  int x, int y, int w, int h) {
    size_t off;
    if (!pointer_to_offset(px, py, x, y, w, h, &off)) return;
    editor_selection_begin();   /* anchor at the press point if unset */
    move_to_offset(off);
    g_desired_col = -1;
}

/* ----- syntax highlighting (GLSL ES 1.00, Dracula palette) -------- *
 *
 * The font is monospace, so a token that starts at column `c` is drawn
 * at `text_x + c * advance`. We tokenize each visible line and emit one
 * colored `renderer_draw_text` span per token. The only state that
 * crosses a line boundary is "are we inside a block comment" — GLSL has
 * no string literals — so the renderer threads a single `in_block` flag
 * from one visible line to the next, seeded from the buffer prefix above
 * the viewport by block_comment_state_at().
 *
 * Six semantic colors (Dracula), plus the Dracula foreground for
 * everything else (whitespace, identifiers not in a word list, and the
 * structural delimiters ()[]{};,.). "Operator" covers the arithmetic /
 * comparison / logical / assignment symbols; delimiters are left default
 * to keep the punctuation noise down. */
static const float HL_DEFAULT[3]  = {0.973f, 0.973f, 0.949f}; /* #f8f8f2 */
static const float HL_COMMENT[3]  = {0.384f, 0.447f, 0.643f}; /* #6272a4 */
static const float HL_KEYWORD[3]  = {1.000f, 0.475f, 0.776f}; /* #ff79c6 */
static const float HL_TYPE[3]     = {0.545f, 0.914f, 0.992f}; /* #8be9fd */
static const float HL_BUILTIN[3]  = {0.314f, 0.980f, 0.482f}; /* #50fa7b */
static const float HL_NUMBER[3]   = {0.741f, 0.576f, 0.976f}; /* #bd93f9 */
static const float HL_OPERATOR[3] = {0.945f, 0.980f, 0.549f}; /* #f1fa8c */

/* GLSL ES 1.00 control-flow keywords and qualifiers. */
static const char *const HL_KEYWORDS[] = {
    "if", "else", "for", "while", "do", "break", "continue", "return",
    "discard", "in", "out", "inout", "uniform", "attribute", "varying",
    "const", "precision", "highp", "mediump", "lowp", "struct", "true",
    "false", "invariant", NULL,
};

/* Built-in types. */
static const char *const HL_TYPES[] = {
    "void", "bool", "int", "float", "vec2", "vec3", "vec4", "mat2",
    "mat3", "mat4", "ivec2", "ivec3", "ivec4", "bvec2", "bvec3", "bvec4",
    "sampler2D", "samplerCube", NULL,
};

/* Built-in functions, gl_* variables, and the Shadertoy-shape uniforms /
 * entry points our template provides (iTime, iResolution, mainImage, …). */
static const char *const HL_BUILTINS[] = {
    "radians", "degrees", "sin", "cos", "tan", "asin", "acos", "atan",
    "sinh", "cosh", "tanh", "tanh4", "pow", "exp", "log", "exp2", "log2",
    "sqrt", "inversesqrt", "abs", "sign", "floor", "ceil", "fract", "mod",
    "min", "max", "clamp", "mix", "step", "smoothstep", "length",
    "distance", "dot", "cross", "normalize", "reflect", "refract",
    "faceforward", "matrixCompMult", "lessThan", "lessThanEqual",
    "greaterThan", "greaterThanEqual", "equal", "notEqual", "any", "all",
    "not", "texture2D", "texture2DProj", "textureCube", "dFdx", "dFdy",
    "fwidth",
    "gl_FragColor", "gl_FragCoord", "gl_FragData", "gl_Position",
    "gl_PointSize", "gl_PointCoord", "gl_FrontFacing",
    "iResolution", "iTime", "iTimeDelta", "iFrame", "iMouse", "iDate",
    "iSampleRate", "iChannel0", "iChannel1", "iChannel2", "iChannel3",
    "iAudio", "iBufferOffset", "fragCoord", "fragColor", "mainImage",
    "mainSound", NULL,
};

static inline int hl_is_digit(unsigned char c)  { return c >= '0' && c <= '9'; }
static inline int hl_is_ident_start(unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}
static inline int hl_is_ident_char(unsigned char c) {
    return hl_is_ident_start(c) || hl_is_digit(c);
}
static inline int hl_is_operator(unsigned char c) {
    return c == '+' || c == '-' || c == '*' || c == '/' || c == '%' ||
           c == '=' || c == '<' || c == '>' || c == '!' || c == '&' ||
           c == '|' || c == '^' || c == '~' || c == '?' || c == ':';
}

static int hl_in_list(const char *s, size_t len, const char *const *list) {
    for (size_t i = 0; list[i]; i++) {
        if (strlen(list[i]) == len && memcmp(s, list[i], len) == 0) return 1;
    }
    return 0;
}

static const float *hl_classify_word(const char *s, size_t len) {
    if (hl_in_list(s, len, HL_KEYWORDS)) return HL_KEYWORD;
    if (hl_in_list(s, len, HL_TYPES))    return HL_TYPE;
    if (hl_in_list(s, len, HL_BUILTINS)) return HL_BUILTIN;
    return HL_DEFAULT;
}

/* Compute whether logical offset `target` sits inside a block comment,
 * by tokenizing comments from the buffer start. O(target) — runs once per
 * frame to seed the first visible line's state. Line comments (//) and
 * block comments (slash-star) are tracked; a // inside a block, or a
 * slash-star inside a //, does not nest (matching the GLSL lexer). */
static int block_comment_state_at(size_t target) {
    size_t len = logical_length();
    int in_block = 0, in_line = 0;
    for (size_t i = 0; i < target; i++) {
        unsigned char c = char_at(i);
        unsigned char d = (i + 1 < len) ? char_at(i + 1) : 0;
        if (in_line) { if (c == '\n') in_line = 0; continue; }
        if (in_block) {
            if (c == '*' && d == '/') { in_block = 0; i++; }
            continue;
        }
        if (c == '/' && d == '/') { in_line = 1; i++; }
        else if (c == '/' && d == '*') { in_block = 1; i++; }
    }
    return in_block;
}

/* Tokenize `s[0..n)` and draw each token as a colored span. Drawing is
 * clamped to the first `draw_limit` columns (the visible width); tokens
 * are still scanned past that point so the returned in-block-comment
 * state stays correct when a slash-star-slash terminator lies off-screen.
 * Returns the updated in_block flag for the next line. */
static int draw_highlighted_line(int text_x, int line_y, int advance,
                                 const char *s, size_t n, size_t draw_limit,
                                 int in_block) {
    size_t i = 0;
    while (i < n) {
        size_t start = i;
        const float *color;
        if (in_block) {
            while (i < n) {
                if (s[i] == '*' && i + 1 < n && s[i + 1] == '/') {
                    i += 2; in_block = 0; break;
                }
                i++;
            }
            color = HL_COMMENT;
        } else if (s[i] == '/' && i + 1 < n && s[i + 1] == '/') {
            i = n;                                  /* line comment to EOL */
            color = HL_COMMENT;
        } else if (s[i] == '/' && i + 1 < n && s[i + 1] == '*') {
            i += 2; in_block = 1;
            while (i < n) {
                if (s[i] == '*' && i + 1 < n && s[i + 1] == '/') {
                    i += 2; in_block = 0; break;
                }
                i++;
            }
            color = HL_COMMENT;
        } else if (s[i] == '#') {                   /* preprocessor directive */
            i++;
            while (i < n && hl_is_ident_char((unsigned char) s[i])) i++;
            color = HL_KEYWORD;
        } else if (hl_is_ident_start((unsigned char) s[i])) {
            while (i < n && hl_is_ident_char((unsigned char) s[i])) i++;
            color = hl_classify_word(s + start, i - start);
        } else if (hl_is_digit((unsigned char) s[i]) ||
                   (s[i] == '.' && i + 1 < n &&
                    hl_is_digit((unsigned char) s[i + 1]))) {
            i++;
            while (i < n &&
                   (hl_is_ident_char((unsigned char) s[i]) || s[i] == '.' ||
                    ((s[i] == '+' || s[i] == '-') &&
                     (s[i - 1] == 'e' || s[i - 1] == 'E')))) {
                i++;
            }
            color = HL_NUMBER;
        } else if (hl_is_operator((unsigned char) s[i])) {
            while (i < n && hl_is_operator((unsigned char) s[i])) {
                /* Don't let an operator run swallow a following comment. */
                if (s[i] == '/' && i + 1 < n &&
                    (s[i + 1] == '/' || s[i + 1] == '*')) break;
                i++;
            }
            color = HL_OPERATOR;
        } else {
            /* Whitespace + structural delimiters: one default-colored run,
             * stopping at the next token start. */
            i++;
            while (i < n) {
                unsigned char c = (unsigned char) s[i];
                if (hl_is_ident_start(c) || hl_is_digit(c) ||
                    hl_is_operator(c) || c == '#' ||
                    (c == '.' && i + 1 < n &&
                     hl_is_digit((unsigned char) s[i + 1]))) {
                    break;
                }
                i++;
            }
            color = HL_DEFAULT;
        }

        if (start < draw_limit) {
            size_t end = i < draw_limit ? i : draw_limit;
            renderer_draw_text(text_x + (int) start * advance, line_y,
                               s + start, end - start,
                               color[0], color[1], color[2]);
        }
    }
    return in_block;
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
     * window of `visible_lines` starting at g_top_line, scroll. Only when
     * the cursor moved since the last render — otherwise a wheel scroll
     * (editor_scroll) that pushed the cursor off-screen would be snapped
     * straight back here every frame. */
    int cur_line = editor_cursor_line();
    size_t cur_off = editor_cursor_offset();
    if (cur_off != g_scroll_anchor) {
        if (cur_line < g_top_line) g_top_line = cur_line;
        if (cur_line >= g_top_line + visible_lines) {
            g_top_line = cur_line - visible_lines + 1;
        }
        g_scroll_anchor = cur_off;
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

    /* Seed the syntax highlighter's block-comment state from everything
     * above the first visible line, then thread it down line by line. */
    int in_block = block_comment_state_at(pos);

    /* Visible cursor blink: ON for 600 ms, OFF for 400 ms. Off when
     * unfocused. */
    int cursor_visible = has_focus && (((now_ms / 100) % 10) < 6);

    /* Selection span (logical offsets) for the highlight pass. */
    size_t sel_a = 0, sel_b = 0;
    int has_sel = selection_bounds(&sel_a, &sel_b);

    int total_lines = editor_line_count();
    char line_buf[MAX_LINE_BYTES];
    char gutter_buf[16];
    int line_y = y + EDITOR_TOP_PAD;
    for (int row = 0;
         row < visible_lines && g_top_line + row < total_lines;
         row++) {
        int this_line = g_top_line + row;
        size_t line_start_off = pos;  /* logical offset of this line's col 0 */

        /* Extract this line into line_buf. */
        size_t k = 0;
        while (pos < len) {
            unsigned char c = char_at(pos);
            pos++;
            if (c == '\n') break;
            if (k < sizeof line_buf - 1) line_buf[k++] = (char) c;
        }
        line_buf[k] = '\0';

        int max_cols = text_w / advance;
        if (max_cols < 0) max_cols = 0;

        /* Error-line tint: a full-width red wash behind the failing line. */
        int is_error_line = (g_error_line >= 0 && this_line == g_error_line);
        if (is_error_line) {
            renderer_fill_rect(text_x, line_y, text_w, line_h,
                               ERRLINE_R, ERRLINE_G, ERRLINE_B, ERRLINE_A);
        }

        /* Selection wash: intersect [sel_a, sel_b) with this line. A line
         * fully inside the selection extends one extra cell to hint that
         * the trailing newline is included. */
        if (has_sel && sel_a <= line_start_off + k && sel_b > line_start_off) {
            size_t a = sel_a > line_start_off ? sel_a - line_start_off : 0;
            size_t b = sel_b - line_start_off;
            int newline_sel = b > k;          /* selection runs past EOL */
            if (b > k) b = k;
            if ((size_t) max_cols < a) a = (size_t) max_cols;
            if ((size_t) max_cols < b) b = (size_t) max_cols;
            int wcols = (int) (b - a) + (newline_sel ? 1 : 0);
            if (wcols > 0) {
                renderer_fill_rect(text_x + (int) a * advance, line_y,
                                   wcols * advance, line_h,
                                   SEL_R, SEL_G, SEL_B, SEL_A);
            }
        }

        /* Gutter line number — right-aligned in the gutter. 1-indexed
         * for human-readable display. The failing line is prefixed with
         * '!' and drawn in red. */
        int displayed = this_line + 1;
        if (is_error_line) {
            snprintf(gutter_buf, sizeof gutter_buf, "!%3d", displayed);
            renderer_draw_textz(x + GUTTER_PAD, line_y, gutter_buf,
                                ERRMARK_R, ERRMARK_G, ERRMARK_B);
        } else {
            snprintf(gutter_buf, sizeof gutter_buf, "%4d", displayed);
            renderer_draw_textz(x + GUTTER_PAD, line_y, gutter_buf,
                                GUTTER_FG_R, GUTTER_FG_G, GUTTER_FG_B);
        }

        /* Source text, syntax-highlighted. Drawing is clamped to the
         * visible width; the full line is still scanned so the carried
         * block-comment state stays correct. */
        size_t draw_n = k <= (size_t) max_cols ? k : (size_t) max_cols;
        in_block = draw_highlighted_line(text_x, line_y, advance,
                                         line_buf, k, draw_n, in_block);

        /* Cursor — draw on top if it's on this row. */
        if (cursor_visible) {
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
