import { expect, it, vi } from "vitest";
import { getGlesExtensionString } from "../src/webgl/capabilities.js";

it("advertises WebGL2 core equivalents without claiming optional float rendering", () => {
  const extensions = getGlesExtensionString({getExtension: () => null}).split(" ");
  expect(extensions).toContain("GL_OES_texture_npot");
  expect(extensions).toContain("GL_OES_packed_depth_stencil");
  expect(extensions).not.toContain("GL_EXT_color_buffer_float");
  expect(extensions).not.toContain("GL_OES_texture_float_linear");
});

it("enables supported host extensions before advertising their GLES equivalents", () => {
  const getExtension = vi.fn((name: string) =>
    ["EXT_color_buffer_float", "OES_texture_float_linear"].includes(name) ? {} : null);
  const extensions = getGlesExtensionString({getExtension}).split(" ");
  expect(getExtension).toHaveBeenCalledWith("EXT_color_buffer_float");
  expect(extensions).toContain("GL_EXT_color_buffer_float");
  expect(extensions).toContain("GL_EXT_color_buffer_half_float");
  expect(extensions).toContain("GL_OES_texture_float_linear");
  expect(extensions).not.toContain("GL_EXT_float_blend");
  expect(new Set(extensions).size).toBe(extensions.length);
});
