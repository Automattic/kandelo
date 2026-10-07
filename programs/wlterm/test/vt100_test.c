/*
 * Native unit test for the VT100 core in programs/wlterm/vt100.c.
 *
 * vt100.c depends on wpkdraw only for vt100_render, which these cases never
 * call; the stubs below satisfy the link, as editor_test.c stubs the SDL2
 * renderer. Driven by host/test/wlterm-vt100-unit.test.ts, compiled with
 * -fsanitize=undefined so an arithmetic overflow aborts instead of passing
 * by accident.
 */
#include "../vt100.h"

#include <stdio.h>
#include <string.h>

#include <wpkdraw/wpkdraw.h>
#include <wpkdraw/wpkfont.h>

/* ---- wpkdraw stubs (vt100_render only) ---------------------------------- */
int wpk_text_width(struct wpk_font *f, const char *s) { (void)f; (void)s; return 8; }
int wpk_font_height_px(struct wpk_font *f) { (void)f; return 16; }
int wpk_font_ascent_px(struct wpk_font *f) { (void)f; return 12; }
void wpk_rect(struct wpk_surface *s, int x, int y, int w, int h, wpk_color c) {
    (void)s; (void)x; (void)y; (void)w; (void)h; (void)c;
}
void wpk_text(struct wpk_surface *s, struct wpk_font *f, int x, int y,
              const char *utf8, wpk_color c) {
    (void)s; (void)f; (void)x; (void)y; (void)utf8; (void)c;
}

/* ---- harness ------------------------------------------------------------ */
static int failures;

#define COLS 20
#define ROWS 5

static void feed(struct vt100 *t, const char *bytes, size_t len) {
    vt100_feed(t, bytes, len);
}
#define FEED(t, lit) feed((t), (lit), sizeof(lit) - 1)

/* Row `row` must hold exactly `n` codepoints `want` from column 0, and
 * nothing after them. */
static void expect_row(const char *name, struct vt100 *t, int row,
                       const uint32_t *want, int n) {
    for (int c = 0; c < COLS; c++) {
        uint32_t got = vt100_cell(t, row, c);
        uint32_t exp = c < n ? want[c] : 0;
        if (got != exp) {
            printf("FAIL %s: row %d col %d = U+%04X, want U+%04X\n",
                   name, row, c, got, exp);
            failures++;
            return;
        }
    }
}

static void expect_ascii_row(const char *name, struct vt100 *t, int row,
                             const char *want) {
    uint32_t cps[COLS];
    int n = (int)strlen(want);
    for (int i = 0; i < n; i++) cps[i] = (unsigned char)want[i] == ' ' ? 0 : (unsigned char)want[i];
    /* A space in `want` means a blank (erased) cell. */
    for (int c = 0; c < COLS; c++) {
        uint32_t got = vt100_cell(t, row, c);
        uint32_t exp = c < n ? cps[c] : 0;
        if (got != exp) {
            printf("FAIL %s: row %d col %d = U+%04X, want U+%04X\n",
                   name, row, c, got, exp);
            failures++;
            return;
        }
    }
}

static struct vt100 *fresh(void) { return vt100_create(COLS, ROWS); }

#define FFFD 0xFFFDu

/* ---- UTF-8: one feed ---------------------------------------------------- */
static void utf8_whole(void) {
    struct vt100 *t = fresh();
    FEED(t, "\xc3\xa9\xe2\x82\xac\xf0\x9f\x98\x80");   /* é € 😀 */
    uint32_t w[] = {0xE9, 0x20AC, 0x1F600};
    expect_row("utf8_whole", t, 0, w, 3);
    vt100_destroy(t);
}

/* A truncated sequence must not swallow the byte after it. */
static void utf8_truncated_inline(void) {
    struct vt100 *t = fresh();
    FEED(t, "\xc3" "A");
    uint32_t w[] = {FFFD, 'A'};
    expect_row("utf8_truncated_inline", t, 0, w, 2);
    vt100_destroy(t);
}

/* ---- UTF-8: split across feeds (wlterm reads the PTY in 4 KiB chunks) --- */
static void utf8_split_1_2(void) {
    struct vt100 *t = fresh();
    FEED(t, "\xe2");
    FEED(t, "\x82\xac");
    uint32_t w[] = {0x20AC};
    expect_row("utf8_split_1_2", t, 0, w, 1);
    vt100_destroy(t);
}

static void utf8_split_1_1_2(void) {
    struct vt100 *t = fresh();
    FEED(t, "\xf0");
    FEED(t, "\x9f");
    FEED(t, "\x98\x80");
    uint32_t w[] = {0x1F600};
    expect_row("utf8_split_1_1_2", t, 0, w, 1);
    vt100_destroy(t);
}

static void utf8_split_1_1_1_1(void) {
    struct vt100 *t = fresh();
    FEED(t, "\xf0"); FEED(t, "\x9f"); FEED(t, "\x98"); FEED(t, "\x80");
    uint32_t w[] = {0x1F600};
    expect_row("utf8_split_1_1_1_1", t, 0, w, 1);
    vt100_destroy(t);
}

/* The regression: a non-continuation byte arriving in a LATER feed, while
 * the stash is still short, used to be absorbed into the stash and lost. */
static void utf8_break_in_later_feed(void) {
    struct vt100 *t = fresh();
    FEED(t, "\xf0");
    FEED(t, "A");
    FEED(t, "BC");
    uint32_t w[] = {FFFD, 'A', 'B', 'C'};
    expect_row("utf8_break_in_later_feed", t, 0, w, 4);
    vt100_destroy(t);
}

static void utf8_break_completing_feed(void) {
    struct vt100 *t = fresh();
    FEED(t, "\xe0");
    FEED(t, "A");
    uint32_t w[] = {FFFD, 'A'};
    expect_row("utf8_break_completing_feed", t, 0, w, 2);
    vt100_destroy(t);
}

/* Lead byte near the end of one feed, followed in the SAME feed by a byte
 * that is not a continuation: malformed before the boundary, not split. */
static void utf8_malformed_at_boundary(void) {
    struct vt100 *t = fresh();
    FEED(t, "\xe0" "A");
    uint32_t w[] = {FFFD, 'A'};
    expect_row("utf8_malformed_at_boundary", t, 0, w, 2);
    vt100_destroy(t);
}

/* A control byte interrupting a stashed sequence still acts as control. */
static void utf8_break_by_newline(void) {
    struct vt100 *t = fresh();
    FEED(t, "\xe2");
    FEED(t, "\nX");
    uint32_t w0[] = {FFFD};
    uint32_t w1[] = {'X'};
    expect_row("utf8_break_by_newline row0", t, 0, w0, 1);
    expect_row("utf8_break_by_newline row1", t, 1, w1, 1);
    vt100_destroy(t);
}

/* ---- CSI parameters ------------------------------------------------------ */
static void expect_cursor(const char *name, struct vt100 *t, int row, int col) {
    int r, c;
    vt100_cursor(t, &r, &c);
    if (r != row || c != col) {
        printf("FAIL %s: cursor (%d,%d), want (%d,%d)\n", name, r, c, row, col);
        failures++;
    }
}

/* A 20-digit parameter used to reach INT_MAX via strtol and overflow
 * `cy += params[0]` -- undefined behaviour, which UBSan turns into an abort. */
static void csi_huge_params(void) {
    struct vt100 *t = fresh();
    FEED(t, "\n\n\x1b[99999999999999999999B");
    expect_cursor("csi_huge_down", t, ROWS - 1, 0);
    FEED(t, "\x1b[99999999999999999999C");
    expect_cursor("csi_huge_right", t, ROWS - 1, COLS - 1);
    FEED(t, "\x1b[99999999999999999999A\x1b[99999999999999999999D");
    expect_cursor("csi_huge_up_left", t, 0, 0);
    FEED(t, "\x1b[99999999999999999999;99999999999999999999H");
    expect_cursor("csi_huge_position", t, ROWS - 1, COLS - 1);
    vt100_destroy(t);
}

/* VT100 parameters are unsigned; a '-' is not a sign. This must not become
 * `params[0] - 1` on INT_MIN. */
static void csi_negative_is_not_a_sign(void) {
    struct vt100 *t = fresh();
    FEED(t, "\x1b[3;3H\x1b[-2147483648H");
    int r, c;
    vt100_cursor(t, &r, &c);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) {
        printf("FAIL csi_negative: cursor (%d,%d) out of range\n", r, c);
        failures++;
    }
    vt100_destroy(t);
}

/* ---- erase modes --------------------------------------------------------- */
/* The reviewer's scenario: readline-style redraw with ESC[2K then \r. */
static void el_mode2_redraw(void) {
    struct vt100 *t = fresh();
    FEED(t, "This is a long line");
    FEED(t, "\x1b[2K\rShort");
    expect_ascii_row("el_mode2_redraw", t, 0, "Short");
    vt100_destroy(t);
}

static void el_mode1_start_to_cursor(void) {
    struct vt100 *t = fresh();
    FEED(t, "Hello World");
    FEED(t, "\x1b[1;7H\x1b[1K");        /* cursor on 'W' (col 6), erase 0..6 */
    expect_ascii_row("el_mode1", t, 0, "       orld");
    vt100_destroy(t);
}

static void el_mode0_cursor_to_end(void) {
    struct vt100 *t = fresh();
    FEED(t, "Hello World");
    FEED(t, "\x1b[1;6H\x1b[K");         /* cursor on ' ' (col 5), erase 5.. */
    expect_ascii_row("el_mode0", t, 0, "Hello");
    vt100_destroy(t);
}

static void ed_mode1_start_to_cursor(void) {
    struct vt100 *t = fresh();
    FEED(t, "aaaa\nbbbb\ncccc");
    FEED(t, "\x1b[2;3H\x1b[1J");         /* cursor row 1 col 2: erase through it */
    expect_ascii_row("ed_mode1 row0", t, 0, "");
    expect_ascii_row("ed_mode1 row1", t, 1, "   b");
    expect_ascii_row("ed_mode1 row2", t, 2, "cccc");
    vt100_destroy(t);
}

/* A private-marker sequence (DECSED here) is not ED: it must be consumed
 * and dropped, not read as ESC[2J. */
static void csi_private_is_ignored(void) {
    struct vt100 *t = fresh();
    FEED(t, "keep\x1b[?2Jme");
    expect_ascii_row("csi_private", t, 0, "keepme");
    FEED(t, "\x1b[?25l\x1b[?1049h!");  /* cursor/alt-screen modes: no-ops */
    expect_ascii_row("csi_private_modes", t, 0, "keepme!");
    vt100_destroy(t);
}

/* An intermediate byte (DECSCUSR is "ESC[2 q") makes a different command. */
static void csi_intermediate_is_ignored(void) {
    struct vt100 *t = fresh();
    FEED(t, "ab\x1b[1 Kc");            /* not EL 1 */
    expect_ascii_row("csi_intermediate", t, 0, "abc");
    vt100_destroy(t);
}

/* ESC inside a sequence abandons it and begins a new one; CAN aborts. */
static void csi_aborted(void) {
    struct vt100 *t = fresh();
    FEED(t, "\n\n\x1b[3\x1b[1;2HX");
    expect_cursor("csi_esc_restart", t, 0, 2);
    FEED(t, "\x1b[2\x18J");            /* CAN, then a literal 'J' */
    expect_ascii_row("csi_can_abort", t, 0, " XJ");
    vt100_destroy(t);
}

/* A C0 control inside a sequence executes without ending it. */
static void csi_c0_executes_mid_sequence(void) {
    struct vt100 *t = fresh();
    FEED(t, "abc\x1b[\r2C!");          /* CR runs, then CUF 2 */
    expect_ascii_row("csi_c0", t, 0, "ab!");
    vt100_destroy(t);
}

/* Parameters past the 16th are dropped; the sequence still applies, and
 * the parameters it keeps are the leading ones. The split across feeds
 * checks that parsing carries between reads. */
static void csi_many_params(void) {
    struct vt100 *t = fresh();
    FEED(t, "\x1b[3;4;1;1;1;1;1;1;");
    FEED(t, "1;1;1;1;1;1;1;1;1;1;1;1;1;1;1;1H");
    expect_cursor("csi_many_params", t, 2, 3);
    vt100_destroy(t);
}

/* ED 3 clears the screen (Linux: ED 2 plus scrollback, which we lack). */
static void ed_mode3_clears(void) {
    struct vt100 *t = fresh();
    FEED(t, "aaaa\nbbbb\x1b[3J");
    expect_ascii_row("ed_mode3 row0", t, 0, "");
    expect_ascii_row("ed_mode3 row1", t, 1, "");
    vt100_destroy(t);
}

/* After the last column is written the cursor waits past the edge; EL 0
 * there erases that last cell rather than touching the next row. */
static void el_at_pending_wrap(void) {
    struct vt100 *t = fresh();
    FEED(t, "01234567890123456789");   /* exactly COLS */
    FEED(t, "\x1b[K");
    expect_ascii_row("el_pending_wrap row0", t, 0, "0123456789012345678");
    expect_ascii_row("el_pending_wrap row1", t, 1, "");
    vt100_destroy(t);
}

/* SGR after the last column must keep the pending wrap: the next printable
 * character starts the next row. (Clamping it away lost the wrap on every
 * coloured full-width line.) */
static void sgr_keeps_pending_wrap(void) {
    struct vt100 *t = fresh();
    FEED(t, "01234567890123456789");   /* exactly COLS: wrap now pending */
    FEED(t, "\x1b[31mX\x1b[m");
    expect_ascii_row("sgr_wrap row0", t, 0, "01234567890123456789");
    expect_ascii_row("sgr_wrap row1", t, 1, "X");
    vt100_destroy(t);
}

/* Erase at a pending wrap ends it, as Linux's csi_K clears vc_need_wrap:
 * the next character lands on the last column, not the next row. */
static void el_ends_pending_wrap(void) {
    struct vt100 *t = fresh();
    FEED(t, "01234567890123456789\x1b[KX");
    expect_ascii_row("el_ends_wrap row0", t, 0, "0123456789012345678X");
    expect_ascii_row("el_ends_wrap row1", t, 1, "");
    vt100_destroy(t);
}

static struct vt100 *scroll_fixture(void) {
    struct vt100 *t = fresh();
    FEED(t, "HEAD\x1b[2;1HA\x1b[3;1HB\x1b[4;1HC\x1b[5;1HSTATUS");
    return t;
}

static void scroll_region_preserves_status(void) {
    struct vt100 *t = scroll_fixture();
    FEED(t, "\x1b[2;"); FEED(t, "4r\x1b[4;1H\nN");
    expect_ascii_row("scroll header", t, 0, "HEAD");
    expect_ascii_row("scroll row1", t, 1, "B");
    expect_ascii_row("scroll row2", t, 2, "C");
    expect_ascii_row("scroll row3", t, 3, "N");
    expect_ascii_row("scroll status", t, 4, "STATUS");
    FEED(t, "\x1b[5;1H\n");
    expect_ascii_row("outside region status", t, 4, "STATUS");
    expect_cursor("outside region stays on screen", t, 4, 0);
    vt100_destroy(t);
}

/* The incremental scroll emitted by stock Vim under TERM=vt100: park at
 * the bottom of the editing region, scroll with CR/LF, then restore margins.
 * Scale its 24-row screen to this five-row fixture, retaining a status row. */
static void editor_incremental_scroll(void) {
    struct vt100 *t = scroll_fixture();
    FEED(t, "\x1b[1;4r\x1b[4;1H\r\n\r\n\r\n\x1b[1;5r");
    expect_ascii_row("editor scrolled three rows", t, 0, "C");
    expect_ascii_row("editor status preserved", t, 4, "STATUS");
    expect_cursor("editor margin restore", t, 0, 0);
    vt100_destroy(t);
}

static void scroll_region_wrap_and_indices(void) {
    struct vt100 *t = scroll_fixture();
    FEED(t, "\x1b[2;4r\x1b[4;1H01234567890123456789X");
    expect_ascii_row("wrap header", t, 0, "HEAD");
    expect_ascii_row("wrap shifted row", t, 2, "01234567890123456789");
    expect_ascii_row("wrap bottom", t, 3, "X");
    expect_ascii_row("wrap status", t, 4, "STATUS");
    FEED(t, "\x1b[2;3H\x1b"); FEED(t, "M");
    expect_ascii_row("reverse index blank", t, 1, "");
    expect_ascii_row("reverse index shifted", t, 2, "B");
    expect_cursor("reverse index column", t, 1, 2);
    FEED(t, "\x1b[4;3H\x1b" "D");
    expect_cursor("index column", t, 3, 2);
    FEED(t, "\x1b" "E");
    expect_cursor("next line column", t, 3, 0);
    expect_ascii_row("indices status", t, 4, "STATUS");
    vt100_destroy(t);
}

static void scroll_region_bounds_and_resize(void) {
    struct vt100 *t = scroll_fixture();
    FEED(t, "\x1b[2;4r");
    expect_cursor("region homes cursor", t, 0, 0);
    FEED(t, "\x1b[3;7H\x1b[4;2r\x1b[2;2r\x1b[1;999999999999999r");
    expect_cursor("invalid region preserves cursor", t, 2, 6);
    FEED(t, "\x1b[4;1H\n");
    expect_ascii_row("invalid region preserves margins", t, 4, "STATUS");
    vt100_resize(t, COLS, 4);
    FEED(t, "\x1b[4;1H\n");
    expect_ascii_row("resize restores full region", t, 0, "B");
    FEED(t, "\x1b[2;3r\x1b[r\x1b[4;1H\n");
    expect_ascii_row("default region scrolls full screen", t, 0, "C");
    vt100_destroy(t);
}

int main(void) {
    scroll_region_preserves_status();
    editor_incremental_scroll();
    scroll_region_wrap_and_indices();
    scroll_region_bounds_and_resize();
    utf8_whole();
    utf8_truncated_inline();
    utf8_split_1_2();
    utf8_split_1_1_2();
    utf8_split_1_1_1_1();
    utf8_break_in_later_feed();
    utf8_break_completing_feed();
    utf8_malformed_at_boundary();
    utf8_break_by_newline();
    csi_huge_params();
    csi_negative_is_not_a_sign();
    el_mode2_redraw();
    el_mode1_start_to_cursor();
    el_mode0_cursor_to_end();
    ed_mode1_start_to_cursor();
    csi_private_is_ignored();
    csi_intermediate_is_ignored();
    csi_aborted();
    csi_c0_executes_mid_sequence();
    csi_many_params();
    ed_mode3_clears();
    el_at_pending_wrap();
    sgr_keeps_pending_wrap();
    el_ends_pending_wrap();
    if (failures) {
        printf("vt100_test: %d FAILED\n", failures);
        return 1;
    }
    printf("vt100_test: ALL PASS\n");
    return 0;
}
