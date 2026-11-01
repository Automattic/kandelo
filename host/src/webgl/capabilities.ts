type MaybeExtensionProvider = {
  getExtension?(name: string): object | null;
};

const WEBGL2_CORE_GLES2_EXTENSIONS = [
  // The host supplies an incomplete default framebuffer for surfaceless EGL
  // bindings, including undefined status and native framebuffer errors.
  "GL_OES_surfaceless_context",
  // WebGL2 has full non-power-of-two texture support. Expose the equivalent
  // GLES2 extension so native renderers keep NPOT mipmaps and wrap/filter
  // behavior instead of falling back to ES2's restricted NPOT path.
  "GL_OES_texture_npot",
  // WebGL2 can render to RGBA8 textures. Expose the equivalent GLES2
  // extension so native renderers do not fall back to lower-precision canvases.
  "GL_OES_rgb8_rgba8",
  // WebGL2 accepts GL_MIN/GL_MAX blend equations. GLES2 renderers gate
  // those modes on this extension when not running as an ES3 context.
  "GL_EXT_blend_minmax",
  // WebGL2's RED/RG texture formats are the GLES2 EXT_texture_rg capability.
  "GL_EXT_texture_rg",
  // The bridge normalizes GLES's GL_HALF_FLOAT_OES token to WebGL2's
  // GL_HALF_FLOAT token, so LOVE can safely use its GLES2 half-float path.
  // LUMINANCE/ALPHA float levels are stored as expanded RGBA
  // (luminance-float.ts), which WebGL2 has no unsized format for.
  "GL_OES_texture_float",
  "GL_OES_texture_half_float",
  // WebGL2 makes every 16-bit float format texture-filterable (ES 3.0 table
  // 3.13) with no extension, so LINEAR sampling of half-float textures works
  // natively; without this name GLES2 would require such a texture to be
  // incomplete. (WebGL2 has no OES_texture_half_float_linear object to probe.)
  "GL_OES_texture_half_float_linear",
  // WebGL2 supports depth textures and packed depth/stencil attachments.
  "GL_OES_depth_texture",
  "GL_OES_packed_depth_stencil",
  // Derivatives are core in WebGL2 shaders; advertise the GLES2 feature gate.
  "GL_OES_standard_derivatives",
] as const;

// Browser-dependent capabilities with a GLES 2 extension of their own.
// Not advertised to a GLES 2 context although the host may enable the WebGL
// extension natively:
// - GL_EXT_color_buffer_float and GL_EXT_float_blend require OpenGL ES 3.0
//   and define no GLES 2 interactions.
// - GL_EXT_color_buffer_half_float is a GLES 2 extension, but its
//   FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE_EXT query has no answer in the
//   fixed QOP_GET_FB_ATTACHMENT reply, and WebGL 2 need not make its
//   RGB16F_EXT renderbuffer format renderable.
const OPTIONAL_WEBGL_TO_GLES_EXTENSIONS = [
  {
    webgl: ["OES_texture_float_linear"],
    gles: ["GL_OES_texture_float_linear"],
  },
] as const;

/** True when the GLES extension string this host returns names `name`.
 * Optional groups are probed through getExtension, which also enables the
 * WebGL capability, so an admitted format is one the native call accepts. */
export function glesExtensionAdvertised(gl: MaybeExtensionProvider, name: string): boolean {
  if ((WEBGL2_CORE_GLES2_EXTENSIONS as readonly string[]).includes(name)) return true;
  if (typeof gl.getExtension !== "function") return false;
  return OPTIONAL_WEBGL_TO_GLES_EXTENSIONS.some(group =>
    (group.gles as readonly string[]).includes(name) && group.webgl.some(webgl => gl.getExtension?.(webgl)));
}

export function getGlesExtensionString(gl: MaybeExtensionProvider): string {
  const extensions = new Set<string>(WEBGL2_CORE_GLES2_EXTENSIONS);
  if (typeof gl.getExtension === "function") {
    for (const group of OPTIONAL_WEBGL_TO_GLES_EXTENSIONS) {
      if (group.webgl.some((name) => gl.getExtension?.(name))) {
        for (const name of group.gles) extensions.add(name);
      }
    }
  }
  return [...extensions].sort().join(" ");
}
