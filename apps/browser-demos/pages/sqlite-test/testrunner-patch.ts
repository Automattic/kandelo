export const testrunnerPlatformShim = [
  "# Kandelo testrunner host selection for child jobs.",
  "# This controls only SQLite's helper-script launcher. Keep tcl_platform",
  "# unchanged so the tests continue to observe the real Tcl target.",
  "set ::kandelo_testrunner_host Kandelo",
].join("\n");

const testrunnerGuestPathShim = [
  "# Kandelo guest path shim for all-mode child jobs.",
  "# testrunner.tcl builds child run.sh files from host-normalized paths;",
  "# convert workdir-local paths back to paths relative to each testdirN",
  "# directory, because SQLite runs the script after cd-ing into it.",
  "proc kandelo_guest_path {path} {",
  "  if {[file pathtype $path] != \"absolute\" && [string equal $path [info nameofexec]]} {",
  "    return $path",
  "  }",
  "  set normalized [file normalize $path]",
  "  set topdir [file normalize [file dirname $::testdir]]",
  "  set script [file normalize [info script]]",
  "  if {[string equal $normalized $script]} { return \"../test/testrunner.tcl\" }",
  "  if {[string equal $normalized $topdir]} { return \"..\" }",
  "  set prefix \"${topdir}/\"",
  "  if {[string first $prefix $normalized] == 0} {",
  "    return \"../[string range $normalized [string length $prefix] end]\"",
  "  }",
  "  return $path",
  "}",
  "set ::kandelo_inline_run_sh 1",
  "set ::kandelo_chunk_pipe_output 1",
].join("\n");

function replaceRequired(source: string, search: string, replacement: string, label: string): string {
  if (!source.includes(search)) {
    throw new Error(`SQLite testrunner patch is incompatible: missing ${label}`);
  }
  return source.replace(search, replacement);
}

export function patchTestrunnerForKandelo(runner: string): string {
  let patched = runner;

  if (!patched.includes("Kandelo testrunner host selection for child jobs")) {
    const lines = patched.split("\n");
    if (lines.length < 4) {
      throw new Error("SQLite testrunner patch is incompatible: file is shorter than four lines");
    }
    lines.splice(3, 0, "", testrunnerPlatformShim);
    patched = lines.join("\n");
    patched = replaceRequired(
      patched,
      "switch -nocase -glob -- $tcl_platform(os) {",
      [
        "set testrunner_host $tcl_platform(os)",
        "if {[info exists ::kandelo_testrunner_host]} {",
        "  set testrunner_host $::kandelo_testrunner_host",
        "}",
        "switch -nocase -glob -- $testrunner_host {",
      ].join("\n"),
      "host-selection switch",
    );
    patched = replaceRequired(
      patched,
      "  *openbsd* {\n",
      [
        "  *kandelo* {",
        "    set TRG(platform)    linux",
        "    set TRG(make)        make.sh",
        "    set TRG(makecmd)     \"sh make.sh\"",
        "    set TRG(testfixture) testfixture",
        "    set TRG(shell)       sqlite3",
        "    set TRG(run)         run.sh",
        "    set TRG(runcmd)      \"sh run.sh\"",
        "  }",
        "  *openbsd* {",
        "",
      ].join("\n"),
      "OpenBSD host branch",
    );
  }

  if (!patched.includes("Kandelo guest path shim for all-mode child jobs")) {
    patched = replaceRequired(
      patched,
      "cd $dir\n",
      `cd $dir\n\n${testrunnerGuestPathShim}\n`,
      "child work-directory anchor",
    );
    patched = replaceRequired(
      patched,
      "    set displayname [string map [list $topdir/ {}] $f]\n",
      [
        "    set displayname [string map [list $topdir/ {}] $f]",
        "    set testfixture_guest [kandelo_guest_path $testfixture]",
        "    set testrunner_tcl_guest [kandelo_guest_path $testrunner_tcl]",
        "    set f_guest [kandelo_guest_path $f]",
        "",
      ].join("\n"),
      "job display-name anchor",
    );
    patched = replaceRequired(
      patched,
      "      set cmd \"$testfixture $f\"",
      "      set cmd \"$testfixture_guest $f_guest\"",
      "direct test command anchor",
    );
    patched = replaceRequired(
      patched,
      "      set cmd \"$testfixture $testrunner_tcl $config $f\"",
      "      set cmd \"$testfixture_guest $testrunner_tcl_guest $config $f_guest\"",
      "configured test command anchor",
    );
    patched = replaceRequired(
      patched,
      "    set set_tmp_dir \"export SQLITE_TMPDIR=\\\"[file normalize $dir]\\\"\"",
      "    set set_tmp_dir \"export SQLITE_TMPDIR=.\"",
      "temporary-directory anchor",
    );
    patched = replaceRequired(
      patched,
      "    set fd [open \"|$TRG(runcmd) 2>@1\" r]",
      [
        "    if {[info exists ::kandelo_inline_run_sh] && $::kandelo_inline_run_sh} {",
        "      set inline_cmd \"$set_tmp_dir\\n$job(cmd)\"",
        "      set fd [open \"|sh -c [list $inline_cmd] 2>@1\" r]",
        "    } else {",
        "      set fd [open \"|$TRG(runcmd) 2>@1\" r]",
        "    }",
      ].join("\n"),
      "child shell command anchor",
    );
    patched = replaceRequired(
      patched,
      "    set rc [catch { gets $fd line } res]",
      [
        "    if {[info exists ::kandelo_chunk_pipe_output] && $::kandelo_chunk_pipe_output} {",
        "      set rc [catch { read $fd 4096 } res]",
        "      if {$rc} {",
        "        puts \"ERROR $res\"",
        "      }",
        "      if {!$rc && [string length $res] > 0} {",
        "        append O($iJob) $res",
        "      }",
        "    } else {",
        "      set rc [catch { gets $fd line } res]",
      ].join("\n"),
      "pipe read anchor",
    );
    patched = replaceRequired(
      patched,
      "    if {$res>=0} {",
      [
        "    if {![info exists ::kandelo_chunk_pipe_output] || !$::kandelo_chunk_pipe_output} {",
        "      if {$res>=0} {",
      ].join("\n"),
      "line-result anchor",
    );
    patched = replaceRequired(
      patched,
      "      append O($iJob) \"$line\\n\"",
      [
        "      append O($iJob) \"$line\\n\"",
        "      }",
        "    }",
      ].join("\n"),
      "line append anchor",
    );
  }

  for (const required of [
    "Kandelo testrunner host selection for child jobs",
    "set ::kandelo_testrunner_host Kandelo",
    "switch -nocase -glob -- $testrunner_host",
    "*kandelo* {",
    "Kandelo guest path shim for all-mode child jobs",
    "set testfixture_guest [kandelo_guest_path $testfixture]",
    "set cmd \"$testfixture_guest $f_guest\"",
    "set cmd \"$testfixture_guest $testrunner_tcl_guest $config $f_guest\"",
    "set set_tmp_dir \"export SQLITE_TMPDIR=.\"",
    "set fd [open \"|sh -c [list $inline_cmd] 2>@1\" r]",
    "set ::kandelo_chunk_pipe_output 1",
    "set rc [catch { read $fd 4096 } res]",
  ]) {
    if (!patched.includes(required)) {
      throw new Error(`SQLite testrunner patch is incomplete: missing ${required}`);
    }
  }

  return patched;
}
