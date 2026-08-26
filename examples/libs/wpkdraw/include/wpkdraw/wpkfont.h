/* wpkdraw font engine — stb_truetype over a bundled monospace face.
 *
 * The default font (Inconsolata Regular) is embedded in the archive as a
 * byte array, so wpk_font_load_default() needs no file at runtime and no
 * font staged into the VFS. v1 renders BMP codepoints (<= 0xFFFF); 4-byte
 * UTF-8 sequences decode to '?'.
 */
#ifndef WPKDRAW_FONT_H
#define WPKDRAW_FONT_H

#include "wpkdraw.h"

/* Opaque font handle: an stb_truetype face + a fixed-size glyph cache. */
struct wpk_font;

/* Load the bundled font at `px_size` pixels. Valid px_size is [4, 256];
 * out of range returns NULL with errno = EINVAL. Returns NULL / ENOMEM on
 * allocation failure. */
struct wpk_font *wpk_font_load_default(int px_size);

void wpk_font_destroy(struct wpk_font *f);

/* Pixel width of a UTF-8 string in this font (for layout before wpk_text). */
int wpk_text_width(struct wpk_font *f, const char *utf8);

/* Render a UTF-8 string with (x, y) as the BASELINE (not the top-left),
 * alpha-blended into the surface. */
void wpk_text(struct wpk_surface *s, struct wpk_font *f,
              int x, int y, const char *utf8, wpk_color color);

/* Font metrics in pixels at the loaded size. height = ascent + descent;
 * ascent = baseline above the origin. Used for row/label layout. */
int wpk_font_height_px(struct wpk_font *f);
int wpk_font_ascent_px(struct wpk_font *f);

#endif /* WPKDRAW_FONT_H */
