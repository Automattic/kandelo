/* vt100 — a small VT100/ANSI terminal core for wlterm.
 *
 * In-tree module (only wlterm consumes it in v1; promote to a packaged
 * lib when a second consumer appears). Repurposes the rendering/parsing
 * half of the pre-pivot libwpkterm pseudocode in
 * docs/plans/2026-07-20-wpk-shell-plan.md (Phase A) — cell grid,
 * GROUND/ESCAPE/CSI parser, SGR 16-colour palette, cursor motion, ED/EL
 * erase, UTF-8 decode, dirty-line render via libwpkdraw, and a
 * keysym→bytes input mapper. NO scrollback, NO alt-screen, NO mouse,
 * NO 256-colour.
 */
#ifndef WLTERM_VT100_H
#define WLTERM_VT100_H

#include <stdint.h>
#include <stddef.h>

struct wpk_surface;   /* from wpkdraw */
struct wpk_font;      /* from wpkdraw */

struct vt100;   /* opaque */

/* Modifier bits for vt100_input_key — numerically identical to kwl.h's
 * KWL_MOD_* so wlterm can forward a kwl_event.mods value unchanged. */
#define VT100_MOD_SHIFT 1u
#define VT100_MOD_CTRL  2u
#define VT100_MOD_ALT   4u

/* Allocate a cols × rows grid. NULL on OOM or if cols/rows are out of
 * [4, 512]/[4, 256]. */
struct vt100 *vt100_create(int cols, int rows);
void vt100_destroy(struct vt100 *t);

/* Resize the grid to cols × rows (a tiling compositor changed the window).
 * The overlapping top-left cells are preserved; the cursor is clamped into
 * the new bounds. A no-op (returns 0) if the size is unchanged or out of the
 * vt100_create() bounds; returns 1 if the grid was rebuilt. */
int vt100_resize(struct vt100 *t, int cols, int rows);

/* Feed raw bytes from the child's stdout; advances the cursor and mutates
 * cells per the VT100 subset. */
void vt100_feed(struct vt100 *t, const char *bytes, size_t len);

/* Render the grid into a libwpkdraw surface with its top-left at (x, y).
 * Cell size is derived from the (monospace) font. Only dirty lines are
 * repainted; call vt100_mark_dirty_all() first for a full repaint. */
void vt100_render(struct vt100 *t, struct wpk_surface *s, struct wpk_font *f,
                  int x, int y);

void vt100_mark_dirty_all(struct vt100 *t);

/* Translate a keysym (+ VT100_MOD_* mask) into the byte sequence to write
 * to the child's stdin. Returns the number of bytes written to `out`
 * (<= out_cap), 0 if the key produces no output. */
size_t vt100_input_key(uint32_t keysym, uint32_t mods, char *out,
                       size_t out_cap);

/* 1 if any grid row contains `needle` as an ASCII substring (test/marker
 * helper; ignores codepoints > 0x7f). */
int vt100_contains(const struct vt100 *t, const char *needle);

#endif /* WLTERM_VT100_H */
