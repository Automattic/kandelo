/*
 * programs/sdl2/test/editor_test.c — native unit test for the pure
 * gap-buffer logic in editor.c (insert/delete, movement, selection,
 * clipboard-dup, auto-replace, and undo/redo coalescing).
 *
 * editor.c depends only on renderer.h for its draw calls, so we compile
 * it natively here against the stub renderer below — no SDL/GL/wasm. The
 * host gate runs this via host/test/sdl2-editor-unit.test.ts. Each top
 * level case is one behavior; CHECK reports the first divergence per case
 * and the process exits non-zero if any case fails.
 */

#include "../editor.h"
#include "../renderer.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ----- renderer stubs -------------------------------------------- *
 * editor_render draws through these; the unit test only cares that the
 * geometry math doesn't fault, so they record nothing. The fixed advance
 * / line height give compute_layout a stable grid for the render smoke. */
int  renderer_text_advance(void)     { return 8; }
int  renderer_text_line_height(void) { return 16; }
int  renderer_draw_text(int x, int y, const char *s, size_t n,
                        float r, float g, float b) {
    (void) x; (void) y; (void) s; (void) r; (void) g; (void) b;
    return (int) n * 8;
}
int  renderer_draw_textz(int x, int y, const char *s,
                         float r, float g, float b) {
    return renderer_draw_text(x, y, s, strlen(s), r, g, b);
}
void renderer_fill_rect(int x, int y, int w, int h,
                        float r, float g, float b, float a) {
    (void) x; (void) y; (void) w; (void) h;
    (void) r; (void) g; (void) b; (void) a;
}

/* ----- assertions ------------------------------------------------ */

static int failures = 0;

#define CHECK(cond, msg) do {                                  \
    if (!(cond)) { printf("FAIL: %s\n", (msg)); failures++; }   \
} while (0)

static void check_text(const char *want, const char *label) {
    char *got = editor_dup_text();
    if (!got || strcmp(got, want) != 0) {
        printf("FAIL: %s: got \"%s\" want \"%s\"\n",
               label, got ? got : "(null)", want);
        failures++;
    }
    free(got);
}

static void check_sel(const char *want, const char *label) {
    char *got = editor_selection_dup();
    const char *g = got ? got : "";
    if (strcmp(g, want) != 0) {
        printf("FAIL: %s: selection \"%s\" want \"%s\"\n", label, g, want);
        failures++;
    }
    free(got);
}

/* ----- cases ----------------------------------------------------- */

static void test_insert_delete(void) {
    editor_init("");
    editor_insert_char('a');
    editor_insert_char('b');
    editor_insert_char('c');
    check_text("abc", "insert chars");
    CHECK(editor_cursor_offset() == 3, "insert leaves cursor after text");

    editor_delete_back();
    check_text("ab", "delete_back");

    editor_move_home();
    editor_delete_forward();
    check_text("b", "delete_forward at home");

    editor_init("x");
    editor_move_end();
    editor_insert_text("yz", 2);
    check_text("xyz", "insert_text");

    editor_init("");
    editor_insert_tab();
    check_text("    ", "insert_tab is four spaces");
}

static void test_movement(void) {
    editor_init("ab\ncd");
    editor_move_home();
    CHECK(editor_cursor_offset() == 0, "home → offset 0");
    CHECK(editor_cursor_line() == 0 && editor_cursor_col() == 0,
          "start is line 0 col 0");

    editor_move_down();        /* desired col 0 → line 1 col 0 */
    CHECK(editor_cursor_line() == 1, "move_down advances a line");
    editor_move_end();
    CHECK(editor_cursor_col() == 2, "end of \"cd\" is col 2");
    CHECK(editor_line_count() == 2, "two lines");

    /* Desired-column memory across a short line. */
    editor_init("longline\nx\nlongline");
    editor_move_end();         /* col 8 on line 0 */
    editor_move_down();        /* line 1 "x" is shorter → clamps to col 1 */
    CHECK(editor_cursor_col() == 1, "clamp to short line");
    editor_move_down();        /* line 2 restores desired col 8 */
    CHECK(editor_cursor_col() == 8, "desired column restored");
}

static void test_selection(void) {
    editor_init("hello world");
    editor_selection_begin();          /* anchor at offset 0 */
    for (int i = 0; i < 5; i++) editor_move_right();
    CHECK(editor_has_selection(), "selection active after shift-move");
    check_sel("hello", "selection span");

    editor_selection_clear();
    CHECK(!editor_has_selection(), "selection cleared");

    editor_select_all();
    CHECK(editor_has_selection(), "select_all selects");
    check_sel("hello world", "select_all span");

    /* delete_selection removes the span and lands the cursor at its start. */
    editor_init("hello world");
    editor_selection_begin();
    for (int i = 0; i < 6; i++) editor_move_right();   /* "hello " */
    editor_delete_selection();
    check_text("world", "delete_selection");
    CHECK(editor_cursor_offset() == 0, "cursor at deleted-span start");
    CHECK(!editor_has_selection(), "selection cleared after delete");
}

static void test_auto_replace(void) {
    /* Typing over a selection replaces it (the path every insert caller
     * relies on instead of special-casing). */
    editor_init("hello");
    editor_select_all();
    editor_insert_char('X');
    check_text("X", "insert replaces selection");

    /* Backspace with a selection deletes the selection, not one char. */
    editor_init("hello");
    editor_select_all();
    editor_delete_back();
    check_text("", "backspace deletes selection");

    /* Paste-shaped insert_text over a selection. */
    editor_init("abc");
    editor_select_all();
    editor_insert_text("XY", 2);
    check_text("XY", "insert_text replaces selection");
}

static void test_undo_redo(void) {
    /* A run of same-kind inserts coalesces into one undo step. */
    editor_init("");
    editor_insert_char('a');
    editor_insert_char('b');
    editor_insert_char('c');
    editor_undo();
    check_text("", "coalesced inserts undo as one step");
    editor_redo();
    check_text("abc", "redo restores the group");

    /* A cursor move ends the group, so the next insert is its own step. */
    editor_init("");
    editor_insert_char('a');
    editor_move_left();
    editor_insert_char('b');           /* "ba" */
    check_text("ba", "two groups typed");
    editor_undo();
    check_text("a", "first undo reverts second group");
    editor_undo();
    check_text("", "second undo reverts first group");

    /* A fresh edit clears the redo stack. */
    editor_init("");
    editor_insert_char('a');
    editor_undo();
    editor_insert_char('z');
    editor_redo();                     /* nothing to redo */
    check_text("z", "edit after undo clears redo");
}

static void test_replace_all(void) {
    editor_init("original");
    editor_replace_all("brand new");
    check_text("brand new", "replace_all swaps the buffer");
    CHECK(editor_cursor_offset() == 0, "replace_all resets cursor to top");
    editor_undo();
    check_text("original", "replace_all is a single undo step");
}

static void test_render_smoke(void) {
    /* Exercise the render + error-line path for crash-safety; the stub
     * renderer swallows the draws. */
    editor_init("vec2 uv;\n  bad line\n/* block */ ok");
    editor_set_error_line(1);
    editor_render(0, 0, 400, 300, /*now_ms=*/0, /*has_focus=*/1);
    editor_set_error_line(-1);
    editor_render(0, 0, 400, 300, /*now_ms=*/700, /*has_focus=*/0);
}

int main(void) {
    test_insert_delete();
    test_movement();
    test_selection();
    test_auto_replace();
    test_undo_redo();
    test_replace_all();
    test_render_smoke();
    editor_shutdown();

    if (failures == 0) {
        printf("editor_test: ALL PASS\n");
        return 0;
    }
    printf("editor_test: %d FAILURE(S)\n", failures);
    return 1;
}
