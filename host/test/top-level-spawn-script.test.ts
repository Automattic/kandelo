import { describe, expect, it } from "vitest";
import {
  resolveTopLevelSpawnProgram,
  TopLevelSpawnError,
} from "../src/exec-target";

const WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).buffer;
const text = (value: string) => new TextEncoder().encode(value).buffer as ArrayBuffer;

function reader(files: Record<string, ArrayBuffer>) {
  return async (path: string) => files[path] ?? null;
}

describe("host-initiated spawn of a VFS path", () => {
  it("runs a WebAssembly module as itself", async () => {
    const resolved = await resolveTopLevelSpawnProgram(
      "/usr/bin/tool", ["tool", "-v"], reader({ "/usr/bin/tool": WASM }),
    );
    expect(resolved).toEqual({ bytes: WASM, path: "/usr/bin/tool", argv: ["tool", "-v"] });
  });

  it("runs a #! script through its interpreter, as execve does", async () => {
    const resolved = await resolveTopLevelSpawnProgram(
      "/usr/local/bin/save",
      ["/usr/local/bin/save", "--now"],
      reader({ "/usr/local/bin/save": text("#!/bin/sh\necho hi\n"), "/bin/sh": WASM }),
    );
    expect(resolved.path).toBe("/bin/sh");
    expect(resolved.bytes).toBe(WASM);
    expect(resolved.argv).toEqual(["/bin/sh", "/usr/local/bin/save", "--now"]);
  });

  it("passes the #! line's one optional argument before the script path", async () => {
    const resolved = await resolveTopLevelSpawnProgram(
      "/opt/run",
      ["run"],
      reader({ "/opt/run": text("#!/usr/bin/env  bash -e\r\n"), "/usr/bin/env": WASM }),
    );
    expect(resolved.argv).toEqual(["/usr/bin/env", "bash -e", "/opt/run"]);
  });

  it.each([
    ["a missing program", {}, "/nope", "ENOENT"],
    ["a file that is neither wasm nor a script", { "/x": text("plain text") }, "/x", "ENOEXEC"],
    ["a script whose interpreter is missing", { "/x": text("#!/bin/nosuch\n") }, "/x", "ENOENT"],
    [
      "a script whose interpreter is itself a script",
      { "/x": text("#!/y\n"), "/y": text("#!/bin/sh\n"), "/bin/sh": WASM },
      "/x",
      "ENOEXEC",
    ],
  ] as const)("rejects %s", async (_label, files, path, code) => {
    const failure = await resolveTopLevelSpawnProgram(path, [path], reader(files)).catch((e) => e);
    expect(failure).toBeInstanceOf(TopLevelSpawnError);
    expect(failure.code).toBe(code);
    expect(failure.message.startsWith(`${code}: `)).toBe(true);
  });
});
