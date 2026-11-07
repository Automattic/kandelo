import { expect, it, vi } from "vitest";
import { getGlesExtensionString } from "../src/webgl/capabilities.js";

it("advertises WebGL2 core equivalents without claiming optional float rendering", () => {
  const extensions = getGlesExtensionString({getExtension: () => null}).split(" ");
  expect(extensions).toContain("GL_OES_texture_npot");
  expect(extensions).toContain("GL_OES_packed_depth_stencil");
  expect(extensions).toContain("GL_OES_surfaceless_context");
  expect(extensions).not.toContain("GL_EXT_color_buffer_float");
  expect(extensions).not.toContain("GL_OES_texture_float_linear");
});

it("enables supported host extensions before advertising their GLES equivalents", () => {
  const getExtension = vi.fn((name: string) => name === "OES_texture_float_linear" ? {} : null);
  const extensions = getGlesExtensionString({getExtension}).split(" ");
  expect(getExtension).toHaveBeenCalledWith("OES_texture_float_linear");
  expect(extensions).toContain("GL_OES_texture_float_linear");
  expect(new Set(extensions).size).toBe(extensions.length);
});

// Every name a GLES 2 context advertises must be a GLES 2 extension the
// platform implements completely. EXT_color_buffer_float and EXT_float_blend
// require OpenGL ES 3.0.
it("advertises only implemented GLES 2 extensions whatever the browser offers", () => {
  const extensions = getGlesExtensionString({getExtension: () => ({})}).split(" ");
  expect(extensions.sort()).toEqual([
    "GL_EXT_blend_minmax", "GL_EXT_color_buffer_half_float", "GL_EXT_texture_rg", "GL_OES_depth_texture", "GL_OES_packed_depth_stencil",
    "GL_OES_rgb8_rgba8", "GL_OES_standard_derivatives", "GL_OES_surfaceless_context", "GL_OES_texture_float",
    "GL_OES_texture_float_linear", "GL_OES_texture_half_float", "GL_OES_texture_half_float_linear",
    "GL_OES_texture_npot",
  ]);
});

// WebGL 2 makes the 16-bit float formats texture-filterable (ES 3.0 table
// 3.13) with no extension, so LINEAR sampling of a half-float texture works
// natively and GLES 2 must be told so.
it("advertises half-float linear filtering as a WebGL 2 core capability", () => {
  expect(getGlesExtensionString({getExtension: () => null}).split(" ")).toContain("GL_OES_texture_half_float_linear");
});
