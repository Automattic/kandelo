import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { tryResolveBinary } from "../src/binary-resolver";
import { runGuestBuild } from "../src/node-guest-build";

// The build image's yacc (Berkeley yacc) and lex (flex) generate a working
// parser and scanner: the calculator they produce, compiled and run inside
// Kandelo, evaluates its input. The placeholders they replaced wrote a parser
// that returned without reading anything, and reported success.
const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures/guest-build/yacc-lex");
const kernelPath = tryResolveBinary("kernel.wasm");
const imagePath = tryResolveBinary("programs/kandelo-build-image.vfs.zst");
const available = kernelPath !== null && imagePath !== null;

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available)("yacc and lex inside Kandelo (Node host, build image)", () => {
  it("generate a parser and scanner that work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-yacc-lex-"));
    workspaces.push(dir);
    cpSync(fixture, dir, { recursive: true });
    let log = "";
    const { exitCode } = await runGuestBuild({
      kernelWasm: new Uint8Array(readFileSync(kernelPath!)),
      image: new Uint8Array(readFileSync(imagePath!)),
      request: {
        workspace: dir,
        argv: ["/bin/sh", "-c", "make CC=cc && ./calc.wasm < input.txt > output.txt"],
        sourceDateEpoch: 1704067200,
        timeoutMs: 600_000,
      },
      log: (chunk) => { log += new TextDecoder().decode(chunk); },
    });
    expect(exitCode, log).toBe(0);
    expect(readFileSync(join(dir, "output.txt"), "utf8")).toBe("7\n9\n10\n");
  }, 900_000);
});
