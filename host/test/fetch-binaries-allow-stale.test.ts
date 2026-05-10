/**
 * Unit-ish test for `scripts/fetch-binaries.sh` (Phase C cutover).
 *
 * Exercises the per-package walk: for each
 * `examples/libs/<name>/package.toml` with a `[binary]` block (or
 * any `[binary.<arch>]` sub-table), the script runs
 *
 *     cargo run -p xtask -- build-deps --arch <arch> \
 *         --binaries-dir <repo>/binaries resolve <name>
 *
 * once per declared arch. Packages without a `[binary]` block are
 * skipped (kernel/userspace/source/etc).
 *
 * Strategy: stage a fake "repo root" in a tempdir with a hand-
 * written `examples/libs/` tree of one-line package.toml files
 * (covering: a single-arch binary package, a multi-arch binary
 * package, a binary-less package, and a stray dir without
 * package.toml). Put a fake `cargo` script first on PATH that logs
 * every invocation. Assert the command lines look right.
 *
 * If rustc isn't on PATH we skip — the script calls `rustc -vV` to
 * compute HOST_TARGET, and there's no good reason to shim that.
 *
 * Companion to xtask's resolver/symlink unit tests in
 * `xtask/src/build_deps.rs` (`cmd_resolve_with_binaries_dir_*`).
 * Together they cover both ends of the cutover: this test pins the
 * shell-side walk + flag passthrough, the Rust tests pin the
 * symlink layout the walk depends on.
 *
 * Filename retained from the legacy `--allow-stale` test for git
 * blame continuity; the legacy semantics are preserved as a
 * back-compat-no-op assertion (Phase C: --allow-stale is the new
 * default and the flag is a no-op).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  chmodSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// host/test/ → repo root is two levels up.
const repoRoot = path.resolve(__dirname, "..", "..");

let rustcAvailable = true;
try {
  execFileSync("rustc", ["-vV"], { encoding: "utf8" });
} catch {
  rustcAvailable = false;
}

describe.skipIf(!rustcAvailable)("fetch-binaries.sh per-package walk", () => {
  let fakeRepoRoot: string;
  let fakeBinDir: string;
  let cargoLogPath: string;

  /**
   * Set up a fake "repo root" with:
   *   <root>/examples/libs/<name>/package.toml   (per-package fixtures)
   *   <root>/scripts/fetch-binaries.sh           (copy of the real script)
   *   <root>/fake-bin/cargo                       (PATH shim)
   *
   * Fixtures cover the four cases the script branches on:
   *   - single-arch binary package (`alpha` — defaults to wasm32)
   *   - multi-arch binary package (`bravo` — `arches = ["wasm32", "wasm64"]`)
   *   - per-arch [binary.<arch>] sub-tables (`charlie` — same arches but
   *     uses the sub-table form; the awk parser must accept both)
   *   - binary-less package (`delta` — no [binary] block, must skip)
   *   - stray dir without package.toml (`stray/` — must skip silently)
   *
   * The fake cargo logs every invocation but does no work — it's
   * exercising the shell loop, not the resolver.
   */
  beforeAll(() => {
    fakeRepoRoot = mkdtempSync(path.join(tmpdir(), "wpk-fbpw-"));
    fakeBinDir = path.join(fakeRepoRoot, "fake-bin");
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(path.join(fakeRepoRoot, "scripts"), { recursive: true });

    const libs = path.join(fakeRepoRoot, "examples", "libs");
    mkdirSync(libs, { recursive: true });

    // alpha: single-arch (default wasm32), simple [binary] block.
    mkdirSync(path.join(libs, "alpha"), { recursive: true });
    writeFileSync(
      path.join(libs, "alpha", "package.toml"),
      [
        `kind = "program"`,
        `name = "alpha"`,
        `version = "0.1.0"`,
        `revision = 1`,
        ``,
        `[source]`,
        `url = "https://example.test/alpha.tar.gz"`,
        `sha256 = "${"0".repeat(64)}"`,
        ``,
        `[license]`,
        `spdx = "MIT"`,
        ``,
        `[[outputs]]`,
        `name = "alpha"`,
        `wasm = "alpha.wasm"`,
        `[binary]`,
        `archive_url = "https://example.test/alpha.tar.zst"`,
        `archive_sha256 = "${"a".repeat(64)}"`,
        ``,
      ].join("\n"),
    );

    // bravo: multi-arch with single-line `arches = [...]` and `[binary]`.
    mkdirSync(path.join(libs, "bravo"), { recursive: true });
    writeFileSync(
      path.join(libs, "bravo", "package.toml"),
      [
        `kind = "program"`,
        `name = "bravo"`,
        `version = "0.2.0"`,
        `revision = 1`,
        `arches = ["wasm32", "wasm64"]`,
        ``,
        `[source]`,
        `url = "https://example.test/bravo.tar.gz"`,
        `sha256 = "${"0".repeat(64)}"`,
        ``,
        `[license]`,
        `spdx = "MIT"`,
        ``,
        `[[outputs]]`,
        `name = "bravo"`,
        `wasm = "bravo.wasm"`,
        `[binary]`,
        `archive_url = "https://example.test/bravo.tar.zst"`,
        `archive_sha256 = "${"b".repeat(64)}"`,
        ``,
      ].join("\n"),
    );

    // charlie: multi-arch with per-arch [binary.<arch>] sub-tables.
    // Exercises the awk regex `^\[binary(\..+)?\]`.
    mkdirSync(path.join(libs, "charlie"), { recursive: true });
    writeFileSync(
      path.join(libs, "charlie", "package.toml"),
      [
        `kind = "program"`,
        `name = "charlie"`,
        `version = "0.3.0"`,
        `revision = 1`,
        `arches = ["wasm32", "wasm64"]`,
        ``,
        `[source]`,
        `url = "https://example.test/charlie.tar.gz"`,
        `sha256 = "${"0".repeat(64)}"`,
        ``,
        `[license]`,
        `spdx = "MIT"`,
        ``,
        `[[outputs]]`,
        `name = "charlie"`,
        `wasm = "charlie.wasm"`,
        `[binary.wasm32]`,
        `archive_url = "https://example.test/charlie-wasm32.tar.zst"`,
        `archive_sha256 = "${"c".repeat(64)}"`,
        `[binary.wasm64]`,
        `archive_url = "https://example.test/charlie-wasm64.tar.zst"`,
        `archive_sha256 = "${"d".repeat(64)}"`,
        ``,
      ].join("\n"),
    );

    // delta: kind=program, no [binary] block (mirrors kernel/userspace/
    // examples). Must be skipped silently.
    mkdirSync(path.join(libs, "delta"), { recursive: true });
    writeFileSync(
      path.join(libs, "delta", "package.toml"),
      [
        `kind = "program"`,
        `name = "delta"`,
        `version = "0.4.0"`,
        `revision = 1`,
        ``,
        `[source]`,
        `url = "https://example.test/delta.tar.gz"`,
        `sha256 = "${"0".repeat(64)}"`,
        ``,
        `[license]`,
        `spdx = "MIT"`,
        ``,
        `[[outputs]]`,
        `name = "delta"`,
        `wasm = "delta.wasm"`,
        ``,
      ].join("\n"),
    );

    // stray: dir without package.toml. Must be skipped silently
    // (no error, no "missing" warning).
    mkdirSync(path.join(libs, "stray"), { recursive: true });

    // Copy the real fetch-binaries.sh so it computes
    // REPO_ROOT=fakeRepoRoot via "$(cd "$(dirname "$0")/.." && pwd)".
    copyFileSync(
      path.join(repoRoot, "scripts", "fetch-binaries.sh"),
      path.join(fakeRepoRoot, "scripts", "fetch-binaries.sh"),
    );
    chmodSync(path.join(fakeRepoRoot, "scripts", "fetch-binaries.sh"), 0o755);

    cargoLogPath = path.join(fakeRepoRoot, "cargo.log");

    // Fake cargo: log every invocation. Always succeed (exit 0) —
    // we're testing the shell-side walk, not the resolver.
    const fakeCargo = `#!/usr/bin/env bash
echo "$@" >> "$CARGO_LOG"
exit 0
`;
    const fakeCargoPath = path.join(fakeBinDir, "cargo");
    writeFileSync(fakeCargoPath, fakeCargo);
    chmodSync(fakeCargoPath, 0o755);
  });

  afterAll(() => {
    if (fakeRepoRoot && existsSync(fakeRepoRoot)) {
      rmSync(fakeRepoRoot, { recursive: true, force: true });
    }
  });

  function runScript(extraArgs: string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
  } {
    writeFileSync(cargoLogPath, "");
    const env = {
      ...process.env,
      // Prepend fake-bin so our shim wins over a real `cargo`.
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      CARGO_LOG: cargoLogPath,
    };
    const r = spawnSync(
      "bash",
      [path.join(fakeRepoRoot, "scripts", "fetch-binaries.sh"), ...extraArgs],
      { cwd: fakeRepoRoot, encoding: "utf8", env },
    );
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  }

  /** Lines in the cargo log that match a given pattern. */
  function logLines(pattern: RegExp): string[] {
    const log = readFileSync(cargoLogPath, "utf8");
    return log.split("\n").filter((l) => pattern.test(l));
  }

  it("walks every package with a [binary] block, once per declared arch", () => {
    const { status, stdout, stderr } = runScript([]);
    expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    // alpha: single arch (default wasm32) → 1 build-deps invocation.
    const alphaLines = logLines(/build-deps.*resolve\s+alpha\b/);
    expect(alphaLines.length).toBe(1);
    expect(alphaLines[0]).toMatch(/--arch\s+wasm32/);
    expect(alphaLines[0]).toMatch(/--binaries-dir\s+\S+/);

    // bravo: multi-arch, top-level [binary] → 2 build-deps invocations.
    const bravoLines = logLines(/build-deps.*resolve\s+bravo\b/);
    expect(bravoLines.length).toBe(2);
    expect(bravoLines.some((l) => /--arch\s+wasm32/.test(l))).toBe(true);
    expect(bravoLines.some((l) => /--arch\s+wasm64/.test(l))).toBe(true);

    // charlie: multi-arch, [binary.<arch>] sub-tables → 2 invocations.
    const charlieLines = logLines(/build-deps.*resolve\s+charlie\b/);
    expect(charlieLines.length).toBe(2);
    expect(charlieLines.some((l) => /--arch\s+wasm32/.test(l))).toBe(true);
    expect(charlieLines.some((l) => /--arch\s+wasm64/.test(l))).toBe(true);

    // delta: no [binary] block → no build-deps invocation.
    const deltaLines = logLines(/build-deps.*resolve\s+delta\b/);
    expect(deltaLines.length).toBe(0);

    // Regression gate: the old install-release codepath was deleted in
    // Phase C Task 6. This assertion ensures it doesn't quietly come
    // back as a fallback under any code path — that dead code must
    // stay dead.
    const installLines = logLines(/install-release/);
    expect(installLines.length).toBe(0);

    // Summary prints resolved=5 (alpha ×1 + bravo ×2 + charlie ×2),
    // skipped=1 (delta). The stray dir without package.toml is
    // silently ignored (counted as neither resolved nor skipped).
    expect(stdout).toMatch(/resolved=5\s+total=5\s+skipped=1/);
  });

  it("--allow-stale resolves the same packages as the default (banner printed)", () => {
    const { status, stdout, stderr } = runScript(["--allow-stale"]);
    expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    // Same set of resolves regardless of --allow-stale.
    expect(logLines(/build-deps.*resolve\s+alpha\b/).length).toBe(1);
    expect(logLines(/build-deps.*resolve\s+bravo\b/).length).toBe(2);
    expect(logLines(/build-deps.*resolve\s+charlie\b/).length).toBe(2);
    expect(logLines(/build-deps.*resolve\s+delta\b/).length).toBe(0);

    // Banner line announces the flag so a maintainer hunting through
    // CI logs knows it's active (the message also documents the
    // lenient semantics — failures degrade to warnings).
    expect(stdout).toMatch(/--allow-stale accepted/);
  });

  it("--allow-stale degrades per-package failures to warnings (exit 0)", () => {
    // Without --allow-stale, a single resolve failure exits 1
    // (covered by the next test). With --allow-stale, failures are
    // warnings and the script still exits 0 — matrix-build's prereq
    // step relies on this so an unrelated meta-package's broken
    // source build doesn't abort the matrix entry's actual target
    // build downstream.
    const fakeCargoPath = path.join(fakeBinDir, "cargo");
    const original = readFileSync(fakeCargoPath, "utf8");
    const failingCargo = `#!/usr/bin/env bash
echo "$@" >> "$CARGO_LOG"
for arg in "$@"; do
    if [ "$arg" = "alpha" ]; then exit 1; fi
done
exit 0
`;
    writeFileSync(fakeCargoPath, failingCargo);
    chmodSync(fakeCargoPath, 0o755);
    try {
      const { status, stdout, stderr } = runScript(["--allow-stale"]);
      expect(status, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
      // The failure list is still printed to stderr so the human can
      // see what was skipped — the only difference from strict mode
      // is the exit code.
      expect(stderr).toMatch(/alpha \(wasm32\)/);
      expect(stderr).toMatch(/1 package\(s\) failed/);
      expect(stderr).toMatch(/treating .* failure\(s\) as warnings/);
    } finally {
      writeFileSync(fakeCargoPath, original);
      chmodSync(fakeCargoPath, 0o755);
    }
  });

  it("propagates a build-deps failure as a non-zero exit + stderr listing", () => {
    // Swap the fake cargo for one that fails on the first build-deps
    // invocation only, to verify the script collects failures and
    // reports them at the end (rather than aborting on the first
    // miss). Restore the original fake cargo afterward.
    const fakeCargoPath = path.join(fakeBinDir, "cargo");
    const original = readFileSync(fakeCargoPath, "utf8");
    const failingCargo = `#!/usr/bin/env bash
echo "$@" >> "$CARGO_LOG"
# Fail when resolving "alpha"; succeed for everything else.
for arg in "$@"; do
    if [ "$arg" = "alpha" ]; then exit 1; fi
done
exit 0
`;
    writeFileSync(fakeCargoPath, failingCargo);
    chmodSync(fakeCargoPath, 0o755);
    try {
      const { status, stdout, stderr } = runScript([]);
      expect(status, `stdout:\n${stdout}`).toBe(1);
      // Other packages still get resolved (bravo + charlie ran).
      expect(logLines(/build-deps.*resolve\s+bravo\b/).length).toBe(2);
      expect(logLines(/build-deps.*resolve\s+charlie\b/).length).toBe(2);
      // Failure listing surfaces in stderr.
      expect(stderr).toMatch(/alpha \(wasm32\)/);
      expect(stderr).toMatch(/1 package\(s\) failed/);
    } finally {
      writeFileSync(fakeCargoPath, original);
      chmodSync(fakeCargoPath, 0o755);
    }
  });

  it("--help mentions the per-package walk", () => {
    const r = spawnSync(
      "bash",
      [path.join(fakeRepoRoot, "scripts", "fetch-binaries.sh"), "--help"],
      { cwd: fakeRepoRoot, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    // Header documents the per-package walk and the resolver
    // invocation pattern.
    expect(r.stdout).toMatch(/per-package/);
    expect(r.stdout).toMatch(/build-deps resolve/);
  });
});
