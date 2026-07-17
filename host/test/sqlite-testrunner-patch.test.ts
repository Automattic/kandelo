import { describe, expect, it } from "vitest";
import { patchTestrunnerForKandelo } from "../../apps/browser-demos/pages/sqlite-test/testrunner-patch";

const upstreamFixture = [
  "#!/usr/bin/env tclsh",
  "# SQLite test runner fixture",
  "set TRG(nJob) 1",
  "set dir testdir1",
  "switch -nocase -glob -- $tcl_platform(os) {",
  "  *openbsd* {",
  "  }",
  "}",
  "cd $dir",
  "    set displayname [string map [list $topdir/ {}] $f]",
  "      set cmd \"$testfixture $f\"",
  "      set cmd \"$testfixture $testrunner_tcl $config $f\"",
  "    set set_tmp_dir \"export SQLITE_TMPDIR=\\\"[file normalize $dir]\\\"\"",
  "    set fd [open \"|$TRG(runcmd) 2>@1\" r]",
  "    set rc [catch { gets $fd line } res]",
  "    if {$res>=0} {",
  "      append O($iJob) \"$line\\n\"",
  "    }",
  "",
].join("\n");

describe("SQLite browser testrunner patch", () => {
  it("rewrites all-mode child commands and is idempotent", () => {
    const patched = patchTestrunnerForKandelo(upstreamFixture);

    expect(patched).toContain("set ::kandelo_testrunner_host Kandelo");
    expect(patched).not.toContain("set ::tcl_platform(os)");
    expect(patched).toContain("switch -nocase -glob -- $testrunner_host");
    expect(patched).toContain("*kandelo* {");
    expect(patched).toContain("set testfixture_guest [kandelo_guest_path $testfixture]");
    expect(patched).toContain("set cmd \"$testfixture_guest $f_guest\"");
    expect(patched).toContain("set cmd \"$testfixture_guest $testrunner_tcl_guest $config $f_guest\"");
    expect(patched).toContain("set set_tmp_dir \"export SQLITE_TMPDIR=.\"");
    expect(patched).toContain("set fd [open \"|sh -c [list $inline_cmd] 2>@1\" r]");
    expect(patched).toContain("set rc [catch { read $fd 4096 } res]");
    expect(patchTestrunnerForKandelo(patched)).toBe(patched);
  });

  it("fails loudly when an upstream anchor changes", () => {
    expect(() => patchTestrunnerForKandelo("one\ntwo\nthree\nfour\n")).toThrow(
      "missing host-selection switch",
    );
  });
});
