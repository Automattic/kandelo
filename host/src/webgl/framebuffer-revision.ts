/**
 * Revision of the inputs to draw-time framebuffer facts.
 *
 * Draws and clears need two facts about the bound framebuffer that WebGL 2
 * does not provide: the ES 2.0 completeness clauses it does not apply
 * (image-sizes.ts) and whether the color attachment is RGB storage kept as
 * RGBA (opaque-alpha.ts). Both derive only from framebuffer attachments, the
 * recorded texture levels and renderbuffer images, the native storage views
 * behind texture and renderbuffer objects, and the opaque-storage marks.
 * Every mutation of those inputs advances this counter; the facts are cached
 * against it, so a draw whose framebuffer state is unchanged pays one
 * comparison instead of re-deriving them.
 *
 * The counter is process-wide rather than per context because textures and
 * renderbuffers (and the records describing them) are shared by EGL share
 * groups and EGLImage siblings: a change made through one context can change
 * another context's framebuffer. A spurious advance only costs one
 * re-derivation; a missed one would be wrong, so mutation sites advance it
 * unconditionally.
 */
let revision = 0;

export function framebufferInputsRevision(): number {
  return revision;
}

export function framebufferInputsChanged(): void {
  revision++;
}
