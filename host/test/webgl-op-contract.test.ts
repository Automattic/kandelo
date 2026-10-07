import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import * as hostOps from "../src/webgl/ops.js";

it("keeps GLES command and query tags identical in Rust, C and TypeScript", () => {
  const root = resolve(import.meta.dirname, "../..");
  const rust = readFileSync(resolve(root, "crates/shared/src/lib.rs"), "utf8");
  const c = readFileSync(resolve(root, "libc/glue/gl_abi.h"), "utf8");
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
});
