/*
 * programs/sdl2/editor.h — text editor surface for the left pane of the
 * SDL2 GLSL playground. A monospace gap-buffer editor with cursor +
 * line navigation, sized for one shader source file at a time. Phase 4
 * lands the bare essentials: printable ASCII insert, backspace, delete,
 * arrows, home/end/pgup/pgdn, soft-tab (4 spaces), and enter. Selection
 * / clipboard / undo land in Phase 8 per the playground plan.
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
 * save. Keeping the layers split makes the editor unit-testable on
 * its own (Phase 8) without needing to mock SDL/GL.
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

/* Movement -------------------------------------------------------- */
void editor_move_left(void);
void editor_move_right(void);
void editor_move_up(void);
void editor_move_down(void);
void editor_move_home(void);
void editor_move_end(void);
void editor_move_page_up(int visible_lines);
void editor_move_page_down(int visible_lines);

/* Inspection ------------------------------------------------------ */
size_t editor_text_length(void);
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
