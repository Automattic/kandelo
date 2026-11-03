import { expect, it } from "vitest";
import {
  attachShaderError, bindAttribLocationError, bindTextureError, bufferUsageError, createShaderError, pixelBytes,
  renderbufferStorageError, samplerValueError, sizedFormatTransfer, subImageError, texImageSizeError,
  texParameterValueError, uploadBytes, uploadSizeError, useProgramError, vertexAttribIndexError,
} from "../src/webgl/es2-validation";

const INVALID_ENUM = 0x500, INVALID_VALUE = 0x501, INVALID_OPERATION = 0x502;

it("accepts exactly ES 2.0 table 3.10's TexParameter values", () => {
  // The dEQP-GLES2 negative_api texparameter cases.
  expect(texParameterValueError(0x2800, 0)).toBe(INVALID_ENUM);
  expect(texParameterValueError(0x2801, 0x2901)).toBe(INVALID_ENUM);
  expect(texParameterValueError(0x2802, 0)).toBe(INVALID_ENUM);
  for (const value of [0x2600, 0x2601]) expect(texParameterValueError(0x2800, value)).toBe(0);
  for (const value of [0x2600, 0x2601, 0x2700, 0x2701, 0x2702, 0x2703]) expect(texParameterValueError(0x2801, value)).toBe(0);
  expect(texParameterValueError(0x2800, 0x2700)).toBe(INVALID_ENUM);
  for (const pname of [0x2802, 0x2803]) for (const value of [0x2901, 0x812f, 0x8370])
    expect(texParameterValueError(pname, value)).toBe(0);
  // A float names the nearest integer (ES 2.0 section 2.3.1).
  expect(texParameterValueError(0x2800, 0x2601 + 0.4)).toBe(0);
  expect(texParameterValueError(0x2800, 0x2601 + 0.6)).toBe(INVALID_ENUM);
});

it("bounds TexImage2D/CopyTexImage2D sizes by MAX_TEXTURE_SIZE >> level and requires border 0", () => {
  expect(texImageSizeError(4096, 0, 4096, 4096, 0)).toBe(0);
  expect(texImageSizeError(4096, 0, 4097, 1, 0)).toBe(INVALID_VALUE);
  expect(texImageSizeError(4096, 2, 1024, 1024, 0)).toBe(0);
  expect(texImageSizeError(4096, 2, 1025, 1, 0)).toBe(INVALID_VALUE);
  expect(texImageSizeError(4096, 0, -1, 1, 0)).toBe(INVALID_VALUE);
  expect(texImageSizeError(4096, 0, 1, 1, 1)).toBe(INVALID_VALUE);
  expect(texImageSizeError(4096, 0, 1, 1, -1)).toBe(INVALID_VALUE);
  expect(texImageSizeError(4096, 0, 0, 0, 0)).toBe(0);
});

it("checks sub-image signs always and bounds only against a recorded level", () => {
  const level = { width: 16, height: 16 };
  expect(subImageError(level, 0, 0, 16, 16)).toBe(0);
  expect(subImageError(level, 18, 14, 0, 0)).toBe(INVALID_VALUE);
  expect(subImageError(level, 14, 18, 0, 0)).toBe(INVALID_VALUE);
  expect(subImageError(level, 8, 8, 9, 1)).toBe(INVALID_VALUE);
  expect(subImageError(level, -1, 0, 0, 0)).toBe(INVALID_VALUE);
  expect(subImageError(level, 0, 0, -1, 0)).toBe(INVALID_VALUE);
  // Without a record the host predicts only the sign rule.
  expect(subImageError(undefined, 100, 100, 1, 1)).toBe(0);
  expect(subImageError(undefined, -1, 0, 1, 1)).toBe(INVALID_VALUE);
});

it("orders RenderbufferStorage's target, size and binding rules", () => {
  expect(renderbufferStorageError(0x8d41, 1, 1, 4096, true)).toBe(0);
  expect(renderbufferStorageError(0xffffffff, 1, 1, 4096, true)).toBe(INVALID_ENUM);
  expect(renderbufferStorageError(0x8d40, 1, 1, 4096, true)).toBe(INVALID_ENUM);
  expect(renderbufferStorageError(0x8d41, -1, 1, 4096, true)).toBe(INVALID_VALUE);
  expect(renderbufferStorageError(0x8d41, 4097, 1, 4096, true)).toBe(INVALID_VALUE);
  expect(renderbufferStorageError(0x8d41, 1, 1, 4096, false)).toBe(INVALID_OPERATION);
});

it("allows one attached shader per type", () => {
  expect(attachShaderError([], 0x8b31)).toBe(0);
  expect(attachShaderError([0x8b30], 0x8b31)).toBe(0);
  expect(attachShaderError([0x8b31], 0x8b31)).toBe(INVALID_OPERATION);
  // An unrecorded type predicts nothing.
  expect(attachShaderError([undefined], 0x8b31)).toBe(0);
  expect(attachShaderError([0x8b31], undefined)).toBe(0);
});

it("checks BindAttribLocation's index and gl_ prefix, and attribute array indices", () => {
  expect(bindAttribLocationError(15, 16, "test")).toBe(0);
  expect(bindAttribLocationError(16, 16, "test")).toBe(INVALID_VALUE);
  expect(bindAttribLocationError(15, 16, "gl_test")).toBe(INVALID_OPERATION);
  expect(vertexAttribIndexError(15, 16)).toBe(0);
  expect(vertexAttribIndexError(16, 16)).toBe(INVALID_VALUE);
});

it("gives sized formats the transfer pair WebGL 2 requires", () => {
  expect(sizedFormatTransfer(0x8d62)).toEqual({ format: 0x1907, type: 0x8363 });
  expect(sizedFormatTransfer(0x8056)).toEqual({ format: 0x1908, type: 0x8033 });
  expect(sizedFormatTransfer(0x8057)).toEqual({ format: 0x1908, type: 0x8034 });
  expect(sizedFormatTransfer(0x8058)).toEqual({ format: 0x1908, type: 0x1401 });
  expect(sizedFormatTransfer(0x81a5)).toBeNull();
});

it("checks shader types, link status, texture targets, sampler units and buffer usages", () => {
  expect(createShaderError(0x8b31)).toBe(0); expect(createShaderError(0x8b30)).toBe(0);
  expect(createShaderError(0x8dd9 /* GEOMETRY_SHADER */)).toBe(INVALID_ENUM);
  expect(useProgramError(null, false)).toBe(0);
  expect(useProgramError({}, true)).toBe(0);
  expect(useProgramError({}, false)).toBe(INVALID_OPERATION);
  expect(bindTextureError(undefined, 0x0de1)).toBe(0);
  expect(bindTextureError(0x0de1, 0x0de1)).toBe(0);
  expect(bindTextureError(0x8c1a, 0x0de1)).toBe(INVALID_OPERATION);
  expect(samplerValueError([0, 7], 8)).toBe(0);
  expect(samplerValueError([8], 8)).toBe(INVALID_VALUE);
  expect(samplerValueError([-1], 8)).toBe(INVALID_VALUE);
  for (const usage of [0x88e0, 0x88e4, 0x88e8, 0x88e1, 0x88ea]) expect(bufferUsageError(usage)).toBe(0);
  expect(bufferUsageError(0xffffffff)).toBe(INVALID_ENUM);
});

it("sizes client pixel data as WebGL reads it, padding rows to the unpack alignment", () => {
  expect(pixelBytes(0x1908, 0x1401)).toBe(4);
  expect(pixelBytes(0x1907, 0x1401)).toBe(3);
  expect(pixelBytes(0x1907, 0x8363)).toBe(2);
  expect(pixelBytes(0x1908, 0x1406)).toBe(16);
  expect(pixelBytes(0x190a, 0x140b)).toBe(4);
  expect(pixelBytes(0x1234, 0x1401)).toBeNull();
  // RGB/UNSIGNED_BYTE 3x2 at alignment 4: 9-byte rows padded to 12, last row unpadded.
  expect(uploadBytes(3, 2, 0x1907, 0x1401, 4)).toBe(21);
  expect(uploadBytes(3, 2, 0x1907, 0x1401, 1)).toBe(18);
  expect(uploadBytes(0, 5, 0x1908, 0x1401, 4)).toBe(0);
  expect(uploadSizeError(21, 20)).toBe(INVALID_OPERATION);
  expect(uploadSizeError(21, 21)).toBe(0);
  expect(uploadSizeError(null, 0)).toBe(0);
});
