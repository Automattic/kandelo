/**
 * Smoke test for mandoc (the man viewer/formatter) running on Kandelo.
 *
 * Feeds a tiny mdoc(7) document on stdin and asserts mandoc renders it to
 * readable ASCII text rather than echoing the raw macro source. This test
 * invokes `mandoc -Tascii` directly (not the `man` front-end), so it never
 * takes mandoc's pager code path: mandoc's main.c forces `use_pager = 0`
 * whenever it is reading from a file/stdin rather than doing a `man`-style
 * name lookup (search.argmode == ARG_FILE), independent of whether stdout
 * is a tty. A `man <page>` front-end invocation (added in a later task)
 * does need a MANPAGER/PAGER override since Kandelo test stdout has no tty.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";

const mandocBinary = tryResolveBinary("programs/mandoc.wasm");

const hasMandoc = !!mandocBinary;

const SAMPLE = `.Dd January 1, 2026
.Dt DEMO 1
.Os
.Sh NAME
.Nm demo
.Nd a sample page
.Sh DESCRIPTION
The demo utility does nothing.
`;

describe.skipIf(!hasMandoc)("mandoc renders inside Kandelo", () => {
  it("formats an mdoc document to readable text", async () => {
    const result = await runCentralizedProgram({
      programPath: mandocBinary!,
      argv: ["mandoc", "-Tascii"],
      stdin: SAMPLE,
      env: ["PATH=/usr/bin:/bin"],
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(0);
    // `-Tascii` renders section headers and the name of the utility in bold
    // via classic nroff/groff backspace-overstrike ("N\bNA\bAM\bME\bE"), the
    // same convention `less`/`col -b` unwind for display. Strip it before
    // asserting on plain text, matching `col -b` semantics.
    const plain = result.stdout.replace(/.\x08/g, "");
    expect(plain).toContain("NAME");
    expect(plain).toContain("demo");
    expect(plain).not.toContain(".Sh"); // macros were rendered, not echoed
  });
});
