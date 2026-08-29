type MaybeExtensionProvider = {
  getExtension?(name: string): object | null;
};

const WEBGL2_CORE_GLES2_EXTENSIONS = [
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
  // GL_HALF_FLOAT token, so GLES2 half-float extension callers work.
  "GL_OES_texture_float",
  "GL_OES_texture_half_float",
  // WebGL2 supports depth textures and packed depth/stencil attachments.
  "GL_OES_depth_texture",
  "GL_OES_packed_depth_stencil",
  // Derivatives are core in WebGL2 shaders; advertise the GLES2 feature gate.
  "GL_OES_standard_derivatives",
] as const;

const OPTIONAL_WEBGL_TO_GLES_EXTENSIONS = [
  {
    webgl: ["EXT_color_buffer_float"],
    gles: ["GL_EXT_color_buffer_float", "GL_EXT_color_buffer_half_float"],
  },
  {
    webgl: ["EXT_color_buffer_half_float"],
    gles: ["GL_EXT_color_buffer_half_float"],
  },
  {
    webgl: ["OES_texture_float_linear"],
    gles: ["GL_OES_texture_float_linear"],
  },
  {
    webgl: ["OES_texture_half_float_linear"],
    gles: ["GL_OES_texture_half_float_linear"],
  },
  {
    webgl: ["EXT_float_blend"],
    gles: ["GL_EXT_float_blend"],
  },
] as const;

export function enableGlesBridgeExtensions(gl: MaybeExtensionProvider): void {
  if (typeof gl.getExtension !== "function") return;
  const names = new Set<string>();
  for (const group of OPTIONAL_WEBGL_TO_GLES_EXTENSIONS) {
    for (const name of group.webgl) names.add(name);
  }
  for (const name of names) gl.getExtension(name);
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
