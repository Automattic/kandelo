import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import { ensureDirRecursive, writeVfsBinary } from "../../../../host/src/vfs/image-helpers";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

// Exercise the packaged utility via guest PATH lookup. Sortix separately
// checks that musl catopen/catgets/catclose consume the resulting format.
async function compile(source: string, update?: string, stdin = false) {
  const image = KandeloImageFs.create();
  image.loadImage(
    new Uint8Array(readFileSync(resolveBinary("rootfs.vfs.zst"))),
  );
  // /tmp is a separate per-boot scratch mount; fixture inputs belong on the
  // image's root mount so that normal mount composition does not hide them.
  ensureDirRecursive(image, "/gencat-fixtures");
  writeVfsBinary(image, "/gencat-fixtures/source", new TextEncoder().encode(source), 0o644);
  if (update !== undefined) {
    writeVfsBinary(image, "/gencat-fixtures/update", new TextEncoder().encode(update), 0o644);
  }
  return runCentralizedProgram({
    programPath: resolveBinary("programs/dash.wasm"),
    rootfsImage: await image.saveImage(),
    execPrograms: new Map([
      ["/usr/bin/gencat", resolveBinary("programs/posix-utils-lite/gencat.wasm")],
      ["/usr/bin/cat", resolveBinary("programs/coreutils.wasm")],
    ]),
    argv: ["dash", "-c", stdin ? "gencat - < /gencat-fixtures/source" : update === undefined
      ? "gencat - /gencat-fixtures/source"
      : "gencat /tmp/catalog /gencat-fixtures/source && gencat /tmp/catalog /gencat-fixtures/update && cat /tmp/catalog"],
    env: ["PATH=/usr/bin"],
    timeout: 30_000,
  });
}

function messages(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0)).toBe(0xff88ff89);
  expect(view.getUint32(8) + 20).toBe(bytes.length);
  const output: Record<string, string> = {};
  const messageOffset = 20 + view.getUint32(12);
  const stringOffset = 20 + view.getUint32(16);
  for (let i = 0; i < view.getUint32(4); i++) {
    const setOffset = 20 + i * 12;
    const set = view.getUint32(setOffset);
    const count = view.getUint32(setOffset + 4);
    const first = view.getUint32(setOffset + 8);
    for (let j = 0; j < count; j++) {
      const offset = messageOffset + (first + j) * 12;
      const id = view.getUint32(offset);
      const length = view.getUint32(offset + 4);
      const textOffset = stringOffset + view.getUint32(offset + 8);
      expect(bytes[textOffset + length - 1]).toBe(0);
      output[`${set}:${id}`] = new TextDecoder().decode(
        bytes.subarray(textOffset, textOffset + length - 1),
      );
    }
  }
  return output;
}

describe("packaged gencat", () => {
  it("reads standard input when no message files are specified", async () => {
    const result = await compile("1 Standard input\n", undefined, true);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(messages(result.stdoutBytes)).toEqual({ "1:1": "Standard input" });
  }, 45_000);

  it("compiles quoting, escapes, continued lines and empty messages", async () => {
    const result = await compile([
      "$ comment", "$set 1", "1 First\\nline", "2 ", "3  padded  ",
      "$set 2", "$quote \"", "1 \"Quote \\\" and \\101\"",
      "2 Continued " + "\\", "text", "",
    ].join("\n"));
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(messages(result.stdoutBytes)).toEqual({
      "1:1": "First\nline", "1:2": "", "1:3": " padded  ",
      "2:1": "Quote \" and A", "2:2": "Continued text",
    });
  }, 45_000);

  it("merges catalogs, replaces messages and deletes messages and sets", async () => {
    const result = await compile(
      "$set 1\n1 Original\n2 Removed\n3 Preserved\n$set 2\n1 Removed set\n",
      "$set 1\n1 Replaced\n2\n$delset 2\n$set 3\n1 New\n",
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(messages(result.stdoutBytes)).toEqual({
      "1:1": "Replaced", "1:3": "Preserved", "3:1": "New",
    });
  }, 45_000);

  it("rejects invalid identifiers instead of publishing source text", async () => {
    const result = await compile("$set 0\n1 Invalid\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdoutBytes).toHaveLength(0);
    expect(result.stderr).toContain("gencat:");
  }, 45_000);
});
