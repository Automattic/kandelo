/**
 * gencat(1) must compile message-catalog source into the binary catalog
 * format musl's catopen(3)/catgets(3) read: a big-endian header with magic
 * 0xff88ff89, a sorted set table, a sorted message table, and a string pool
 * (libc/musl/src/locale/catopen.c and catgets.c). The replaced
 * posix-utils-lite gencat copied the source text unchanged, which catopen()
 * rejects; these assertions read the output exactly the way musl does.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const gencat = tryResolveBinary("programs/gencat.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const artifactsAvailable = !!dash && !!gencat && !!coreutils;

const NL_CAT_MAGIC = 0xff88ff89;

/** Look up (set, msg) the way musl's catopen()+catgets() do. */
function catgets(catalog: Uint8Array, setId: number, msgId: number): string | null {
  const view = new DataView(catalog.buffer, catalog.byteOffset, catalog.byteLength);
  // catopen(): magic and recorded size must match the file.
  if (view.getUint32(0) !== NL_CAT_MAGIC) return null;
  if (20 + view.getUint32(8) !== catalog.byteLength) return null;
  const nsets = view.getUint32(4);
  const msgs = 20 + view.getUint32(12);
  const strings = 20 + view.getUint32(16);
  for (let s = 0; s < nsets; s++) {
    const set = 20 + 12 * s;
    if (view.getUint32(set) !== setId) continue;
    const nmsgs = view.getUint32(set + 4);
    const first = msgs + 12 * view.getUint32(set + 8);
    for (let m = 0; m < nmsgs; m++) {
      const msg = first + 12 * m;
      if (view.getUint32(msg) !== msgId) continue;
      const start = strings + view.getUint32(msg + 8);
      const end = catalog.indexOf(0, start);
      return new TextDecoder().decode(catalog.subarray(start, end));
    }
    return null;
  }
  return null;
}

/** Quote `text` as one POSIX shell word. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function compileCatalog(source: string) {
  const execPrograms = new Map<string, string>([
    ["/bin/gencat", gencat!],
    ["/usr/bin/gencat", gencat!],
    ["/bin/cat", coreutils!],
    ["/usr/bin/cat", coreutils!],
  ]);
  return runCentralizedProgram({
    programPath: dash!,
    argv: [
      "dash",
      "-c",
      `printf '%s' ${shellQuote(source)} > /tmp/msgs.msg && ` +
        "gencat /tmp/msgs.cat /tmp/msgs.msg && cat /tmp/msgs.cat",
    ],
    env: ["PATH=/bin:/usr/bin", "HOME=/tmp"],
    execPrograms,
    timeout: 30_000,
  });
}

describe.skipIf(!artifactsAvailable)("gencat", () => {
  it("writes a catalog that musl's catgets() can read", async () => {
    const result = await compileCatalog(
      ["$set 1 first", "1 One", "$set 2 second", "1 Uno", "2 Dos", "3 Tres", ""].join("\n"),
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    const catalog = result.stdoutBytes;
    expect(new DataView(catalog.buffer, catalog.byteOffset).getUint32(0)).toBe(NL_CAT_MAGIC);
    expect(catgets(catalog, 1, 1)).toBe("One");
    expect(catgets(catalog, 2, 1)).toBe("Uno");
    expect(catgets(catalog, 2, 2)).toBe("Dos");
    expect(catgets(catalog, 2, 3)).toBe("Tres");
    expect(catgets(catalog, 2, 4)).toBeNull();
    expect(catgets(catalog, 3, 1)).toBeNull();
  }, 60_000);

  it("applies $quote, escape sequences, and continuation lines", async () => {
    const result = await compileCatalog(
      [
        "$quote \"",
        "$set 7",
        "1 \"tab\\there\"",
        "2 first half \\",
        "second half",
        "3 line\\nbreak",
        "",
      ].join("\n"),
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(catgets(result.stdoutBytes, 7, 1)).toBe("tab\there");
    expect(catgets(result.stdoutBytes, 7, 2)).toBe("first half second half");
    expect(catgets(result.stdoutBytes, 7, 3)).toBe("line\nbreak");
  }, 60_000);

  it("rejects malformed source instead of writing a catalog", async () => {
    const result = await compileCatalog("$set notanumber\n1 One\n");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdoutBytes.byteLength).toBe(0);
  }, 60_000);
});
