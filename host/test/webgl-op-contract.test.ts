import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { COMPRESSED_UPLOAD_MAX_BYTES } from "../src/webgl/compressed-upload.js";
import { WPK_IMAGE_SOURCE_TARGET } from "../src/webgl/image-storage.js";
import * as hostOps from "../src/webgl/ops.js";

it("keeps GLES command and query tags identical in Rust, C and TypeScript", () => {
  const root = resolve(import.meta.dirname, "../..");
  const rust = readFileSync(resolve(root, "crates/shared/src/lib.rs"), "utf8");
  const c = readFileSync(resolve(root, "libc/glue/gl_abi.h"), "utf8");
  expect(Number(rust.match(/pub const IMAGE_SOURCE_TARGET: u32 = (0x[0-9a-fA-F_]+);/)![1].replaceAll("_",""))).toBe(WPK_IMAGE_SOURCE_TARGET);
  expect(Number(c.match(/^#define WPK_GL_IMAGE_SOURCE_TARGET (0x[0-9a-fA-F]+)/m)![1])).toBe(WPK_IMAGE_SOURCE_TARGET);
  const rustOps = Object.fromEntries([...rust.matchAll(/pub const ((?:Q?OP)_[A-Z0-9_]+): u(?:16|32) = (0x[0-9a-fA-F]+|\d+);/g)]
    .map(match => [match[1], Number(match[2])]));
  const cOps = Object.fromEntries([...c.matchAll(/^#define ((?:Q?OP)_[A-Z0-9_]+)\s+(0x[0-9a-fA-F]+|\d+)/gm)]
    .map(match => [match[1], Number(match[2])]));
  // OP_VERSION uses WPK_GL_OP_VERSION in C, rather than a command tag.
  const { OP_VERSION, ...commands } = rustOps;
  expect(cOps).toEqual(commands);
  expect(hostOps).toMatchObject(rustOps);
  for (const prefix of ["OP_", "QOP_"]) {
    const values = Object.entries(commands).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value);
    expect(new Set(values).size).toBe(values.length);
  }
  expect(c).toMatch(new RegExp(`#define WPK_GL_OP_VERSION\\s+${OP_VERSION}(?:u)?\\b`));
  const inline = rust.match(/pub mod inline_client_draw \{([^}]+)\}/)![1];
  for (const [rustName,hostName] of [["HEADER_BYTES","INLINE_DRAW_HEADER_BYTES"],["ATTRIBUTE_BYTES","INLINE_DRAW_ATTRIBUTE_BYTES"],
    ["MAX_BYTES","INLINE_DRAW_MAX_BYTES"],["MAX_ATTRIBUTES","INLINE_DRAW_MAX_ATTRIBUTES"]] as const) {
    const value = Number(inline.match(new RegExp(`pub const ${rustName}: u32 = (\\d+);`))![1]);
    expect(hostOps[hostName]).toBe(value);
    expect(c).toMatch(new RegExp(`#define WPK_GL_INLINE_DRAW_${rustName}\\s+${value}u?\\b`));
  }
});

it("binds opaque compressed staging to the shared Program contract and exact source limits",()=>{
  const root=resolve(import.meta.dirname,"../.."),snapshot=JSON.parse(readFileSync(resolve(root,"abi/snapshot.json"),"utf8"));
  const wire=snapshot.gl_compressed_upload;
  expect(wire.query).toBe(hostOps.QOP_COMPRESSED_UPLOAD);
  expect(wire.max_staged_bytes).toBe(COMPRESSED_UPLOAD_MAX_BYTES);
  const c=readFileSync(resolve(root,"libc/glue/gl_abi.h"),"utf8");
  expect(c).toContain(`#define WPK_GL_COMPRESSED_UPLOAD_MAX_BYTES ${wire.max_staged_bytes}u`);
  expect(wire.begin_bytes).toBe(13*4);expect(wire.continuation_header_bytes).toBe(3*4);
  expect(wire.begin_acceptance).toBe("custody-only-not-native-storage-validation");
  expect(snapshot.abi_surfaces.program).toContain("gl_compressed_upload");
});
