/*
 * programs/sdl2/editor.h — text editor surface for the left pane of the
 * SDL2 GLSL playground. A monospace gap-buffer editor sized for one
 * shader source file at a time: printable ASCII insert, backspace,
 * delete, arrows, home/end/pgup/pgdn, soft-tab, enter, selection,
 * clipboard-friendly dup, and undo/redo.
 *
 * Cursor convention: `cursor` is a logical character offset in the
 * range [0, length()]; insert at cursor places the new character just
 * before the cursor, then advances it by one (so the cursor stays
 * immediately after the last typed character).
 *
 * The editor is pure state + rendering — it does NOT debounce, it
 * does NOT recompile, it does NOT write to disk. Those are main.c's
 * concerns; main.c calls into the editor for each keystroke and reads
 * back the text via editor_dup_text() when it's time to recompile or
 * save. Keeping the layers split makes the editor unit-testable on its
 * own without mocking SDL/GL (see programs/sdl2/test/editor_test.c).
 */
#pragma once

#include <stddef.h>

void editor_init(const char *initial_text);
void editor_shutdown(void);

/* Insertions ------------------------------------------------------ */
void editor_insert_char(char c);
void editor_insert_text(const char *s, size_t n);
void editor_insert_newline(void);
void editor_insert_tab(void);  /* soft tab: 4 spaces */

/* Deletions ------------------------------------------------------- */
void editor_delete_back(void);     /* backspace */
void editor_delete_forward(void);  /* delete key */

/* Selection + clipboard ------------------------------------------- *
 *
 * Selection is an anchor offset plus the cursor: the selected span is
 * [min(anchor,cursor), max(anchor,cursor)). main.c drives it from the
 * keyboard/mouse: call editor_selection_begin() before a shift-extended
 * move (anchors at the current cursor if not already anchored), and
 * editor_selection_clear() before a plain move/click. Insert/delete
 * automatically replace the active selection, so callers don't special-
 * case it. */
void   editor_selection_begin(void);   /* anchor at cursor if unanchored */
void   editor_selection_clear(void);
void   editor_select_all(void);
int    editor_has_selection(void);
/* malloc'd null-terminated copy of the selected text, or NULL if the
 * selection is empty. */
char  *editor_selection_dup(void);
/* Remove the selected span (cursor lands at its start). No-op if empty. */
void   editor_delete_selection(void);

/* Undo / redo ----------------------------------------------------- *
 * Snapshot ring (~32 states) of (text, cursor). Consecutive same-kind
 * edits coalesce into one step; a cursor move or selection change ends
 * the current group. */
void editor_undo(void);
void editor_redo(void);

/* Replace the whole buffer (preset load). Recorded as one undo step;
 * cursor resets to the top and any selection is cleared. */
void editor_replace_all(const char *text);

/* Error-line marker ----------------------------------------------- *
 * `line0` is the 0-indexed editor line the last compile error maps to,
 * or -1 to clear. editor_render tints that line and prefixes its gutter
 * number with '!'. */
void editor_set_error_line(int line0);

/* Movement -------------------------------------------------------- */
void editor_move_left(void);
void editor_move_right(void);
void editor_move_up(void);
void editor_move_down(void);
void editor_move_home(void);
void editor_move_end(void);
void editor_move_page_up(int visible_lines);
void editor_move_page_down(int visible_lines);
/* Scroll the viewport by delta_lines without moving the cursor (mouse
 * wheel). Negative scrolls toward the top of the file. */
void editor_scroll(int delta_lines);

/* Inspection ------------------------------------------------------ */
size_t editor_cursor_offset(void);
int    editor_cursor_line(void);
int    editor_cursor_col(void);
int    editor_line_count(void);

/* Returns a malloc'd null-terminated copy of the entire text. */
char  *editor_dup_text(void);

/* Render the editor surface into the pixel rectangle (x, y, w, h)
 * of the window. `now_ms` drives the cursor blink. The renderer module
 * handles the actual glyph drawing; the editor owns layout, gutter,
 * and scrolling. `has_focus` toggles a solid vs hollow cursor. */
void editor_render(int x, int y, int w, int h,
                   unsigned int now_ms, int has_focus);

/* Move the cursor to the buffer offset under the window-pixel point
 * (px, py), given the same editor render rectangle (x, y, w, h) the
 * frame was drawn with. Clamps the column to the line length and the
 * line to the last visible line. */
void editor_pointer_set_cursor(int px, int py,
                               int x, int y, int w, int h);

/* Like editor_pointer_set_cursor but keeps the selection anchor fixed
 * and moves only the cursor — the mouse-drag selection path. Anchors at
 * the current cursor first if there is no active selection. */
void editor_pointer_extend_select(int px, int py,
                                  int x, int y, int w, int h);
