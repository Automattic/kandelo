/**
 * Unit-ish test for `scripts/fetch-binaries.sh` (Phase C cutover).
 *
 * Exercises the per-package walk: for each
 * `packages/registry/<name>/package.toml` with a sibling `build.toml`,
 * the script runs
 *
 *     cargo run -p xtask -- build-deps --arch <arch> \
 *         --binaries-dir <repo>/binaries resolve <name>
 *
 * once per declared arch. Packages without a sibling `build.toml` are
 * skipped (source/helper or stale manifest-only entries).
 *
 * Strategy: stage a fake "repo root" in a tempdir with a hand-
 * written `packages/registry/` tree of one-line package.toml files
 * (covering: a single-arch binary package, a multi-arch binary
 * package, a package without build.toml, and a stray dir without
 * package.toml). Put a fake `cargo` script first on PATH that logs
 * every invocation. Assert the command lines look right.
 *
 * If rustc isn't on PATH we skip — the script calls `rustc -vV` to
 * compute HOST_TARGET, and there's no good reason to shim that.
 *
 * Companion to xtask's resolver/symlink unit tests in
 * `tools/xtask/src/build_deps.rs` (`cmd_resolve_with_binaries_dir_*`).
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
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tests/package-system/ -> repo root is two levels up.
const repoRoot = path.resolve(__dirname, "..", "..");

let rustcAvailable = true;
try {
  execFileSync("rustc", ["-vV"], { encoding: "utf8" });
} catch {
  rustcAvailable = false;
}
let jqAvailable = true;
try {
  execFileSync("jq", ["--version"], { encoding: "utf8" });
} catch {
  jqAvailable = false;
}

describe.skipIf(!rustcAvailable)("fetch-binaries.sh per-package walk", () => {
  let fakeRepoRoot: string;
  let fakeBinDir: string;
  let cargoLogPath: string;

  /**
   * Set up a fake "repo root" with:
   *   <root>/packages/registry/<name>/package.toml   (per-package fixtures)
   *   <root>/scripts/fetch-binaries.sh           (copy of the real script)
   *   <root>/fake-bin/cargo                       (PATH shim)
   *
   * Fixtures cover the four cases the script branches on:
   *   - single-arch binary package (`alpha` — defaults to wasm32)
   *   - multi-arch binary package (`bravo` — `arches = ["wasm32", "wasm64"]`)
   *   - another multi-arch package (`charlie` — catches repeated arch parsing)
   *   - package without build.toml (`delta` — must skip)
   *   - kind=source package WITH build.toml (`sourcepkg` — must skip by kind)
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

    const registry = path.join(fakeRepoRoot, "packages", "registry");
    mkdirSync(registry, { recursive: true });

    // alpha: single-arch (default wasm32), publishable via build.toml.
    mkdirSync(path.join(registry, "alpha"), { recursive: true });
    writeFileSync(
      path.join(registry, "alpha", "package.toml"),
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
        ``,
      ].join("\n"),
    );
    writeFileSync(path.join(registry, "alpha", "build.toml"), `revision = 1\n`);

    // bravo: multi-arch with single-line `arches = [...]`.
    mkdirSync(path.join(registry, "bravo"), { recursive: true });
    writeFileSync(
      path.join(registry, "bravo", "package.toml"),
      [
        `kind = "program"`,
        `name = "bravo"`,
        `version = "0.2.0"`,
        `revision = 1`,
        `arches = ["wasm32", "wasm64"]`,
        `depends_on = ["alpha@0.1.0"]`,
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
        ``,
      ].join("\n"),
    );
    writeFileSync(path.join(registry, "bravo", "build.toml"), `revision = 1\n`);

    // charlie: another multi-arch package.
    mkdirSync(path.join(registry, "charlie"), { recursive: true });
    writeFileSync(
      path.join(registry, "charlie", "package.toml"),
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
        ``,
      ].join("\n"),
    );
    writeFileSync(path.join(registry, "charlie", "build.toml"), `revision = 1\n`);

    // delta: kind=program, no build.toml (mirrors source/helper or stale
    // manifest-only entries). Must be skipped silently.
    mkdirSync(path.join(registry, "delta"), { recursive: true });
    writeFileSync(
      path.join(registry, "delta", "package.toml"),
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

    // sourcepkg: kind=source WITH a build.toml (mirrors
    // wayland-protocols, which carries build.toml only for its
    // `inputs` cache-key list). The build.toml check below would
    // treat it as publishable, so it must be skipped by kind first —
    // a source package can never resolve under --fetch-only.
    mkdirSync(path.join(registry, "sourcepkg"), { recursive: true });
    writeFileSync(
      path.join(registry, "sourcepkg", "package.toml"),
      [
        `kind = "source"`,
        `name = "sourcepkg"`,
        `version = "0.5.0"`,
        `revision = 1`,
        ``,
        `[source]`,
        `url = "https://example.test/sourcepkg.tar.gz"`,
        `sha256 = "${"0".repeat(64)}"`,
        ``,
        `[license]`,
        `spdx = "MIT"`,
        ``,
      ].join("\n"),
    );
    writeFileSync(path.join(registry, "sourcepkg", "build.toml"), `revision = 1\n`);

    // stray: dir without package.toml. Must be skipped silently
    // (no error, no "missing" warning).
    mkdirSync(path.join(registry, "stray"), { recursive: true });

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

  function runScript(
    extraArgs: string[],
    envOverrides: NodeJS.ProcessEnv = {},
  ): {
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
      WASM_POSIX_FETCH_SKIP_PKGS: "",
      ...envOverrides,
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

  function writeExpectedLedger(
    name: string,
    entries: Array<string | { package: string; arch: string }>,
  ): string {
    const ledger = path.join(fakeRepoRoot, name);
    writeFileSync(
      ledger,
      `${JSON.stringify({
        abi_version: 42,
        entries: entries.map((entry) =>
          typeof entry === "string"
            ? { package: entry, arch: "wasm32" }
            : entry
        ),
      })}\n`,
    );
    return ledger;
  }

  it("walks every package with build.toml, once per declared arch", () => {
    const { status, stdout, stderr } = runScript([]);
    expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    // alpha: single arch (default wasm32) → 1 build-deps invocation.
    const alphaLines = logLines(/build-deps.*resolve\s+alpha\b/);
    expect(alphaLines.length).toBe(1);
    expect(alphaLines[0]).toMatch(/--arch\s+wasm32/);
    expect(alphaLines[0]).toMatch(/--binaries-dir\s+\S+/);

    // bravo: multi-arch → 2 build-deps invocations.
    const bravoLines = logLines(/build-deps.*resolve\s+bravo\b/);
    expect(bravoLines.length).toBe(2);
    expect(bravoLines.some((l) => /--arch\s+wasm32/.test(l))).toBe(true);
    expect(bravoLines.some((l) => /--arch\s+wasm64/.test(l))).toBe(true);

    // charlie: multi-arch → 2 build-deps invocations.
    const charlieLines = logLines(/build-deps.*resolve\s+charlie\b/);
    expect(charlieLines.length).toBe(2);
    expect(charlieLines.some((l) => /--arch\s+wasm32/.test(l))).toBe(true);
    expect(charlieLines.some((l) => /--arch\s+wasm64/.test(l))).toBe(true);

    // delta: no build.toml → no build-deps invocation.
    const deltaLines = logLines(/build-deps.*resolve\s+delta\b/);
    expect(deltaLines.length).toBe(0);

    // sourcepkg: kind=source (despite a build.toml) → no invocation.
    const sourceLines = logLines(/build-deps.*resolve\s+sourcepkg\b/);
    expect(sourceLines.length).toBe(0);

    // Regression gate: the old install-release codepath was deleted in
    // Phase C Task 6. This assertion ensures it doesn't quietly come
    // back as a fallback under any code path — that dead code must
    // stay dead.
    const installLines = logLines(/install-release/);
    expect(installLines.length).toBe(0);

    // Summary prints resolved=5 (alpha ×1 + bravo ×2 + charlie ×2),
    // skipped=2 (delta + sourcepkg). The stray dir without
    // package.toml is silently ignored (neither resolved nor skipped).
    expect(stdout).toMatch(/resolved=5\s+total=5\s+skipped=2/);
  });

  it("selects one package root without changing resolver dependency ownership", () => {
    const { status, stdout, stderr } = runScript(["--package", "bravo"]);
    expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    // bravo declares alpha as a dependency in its package.toml fixture. The
    // wrapper invokes only the selected root; xtask's resolver owns recursive
    // dependency materialization and must not be reimplemented by this loop.
    expect(logLines(/build-deps.*resolve\s+bravo\b/).length).toBe(2);
    expect(logLines(/build-deps.*resolve\s+alpha\b/).length).toBe(0);
    expect(logLines(/build-deps.*resolve\s+charlie\b/).length).toBe(0);
    expect(stdout).toContain("selected package roots: bravo");
    expect(stdout).toMatch(/resolved=2\s+total=2\s+skipped=0/);
  });

  it("selects many roots in first-requested order and de-duplicates repeats", () => {
    const { status, stdout, stderr } = runScript([
      "--package", "charlie",
      "--package=alpha",
      "--package", "charlie",
    ]);
    expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    const selectedOrder = logLines(/build-deps.*resolve\s+(?:alpha|charlie)\b/)
      .map((line) => line.match(/resolve\s+(alpha|charlie)\b/)?.[1]);
    expect(selectedOrder).toEqual(["charlie", "charlie", "alpha"]);
    expect(stdout).toContain("selected package roots: charlie alpha");
    expect(stdout).toMatch(/resolved=3\s+total=3\s+skipped=0/);
  });

  it("rejects unknown and non-publishable selected roots before resolving", () => {
    for (const packageName of ["missing", "delta"]) {
      const { status, stderr } = runScript(["--package", packageName]);
      expect(status).toBe(2);
      expect(stderr).toMatch(
        packageName === "missing"
          ? /selected package 'missing' does not exist/
          : /selected package 'delta' has no publishable build\.toml/,
      );
      expect(logLines(/build-deps.*resolve/)).toEqual([]);
    }
  });

  it("rejects empty and unsafe selected package names", () => {
    for (const args of [
      ["--package", ""],
      ["--package="],
      ["--package", "../alpha"],
      ["--package", "alpha/bravo"],
      ["--package", "-alpha"],
      ["--package", "alpha bravo"],
    ]) {
      const { status, stderr } = runScript(args);
      expect(status).toBe(2);
      expect(stderr).toMatch(/requires a safe non-empty package name/);
      expect(logLines(/build-deps.*resolve/)).toEqual([]);
    }

    const missingValue = runScript(["--package"]);
    expect(missingValue.status).toBe(2);
    expect(missingValue.stderr).toMatch(/--package requires a package name/);
    expect(logLines(/build-deps.*resolve/)).toEqual([]);
  });

  it("rejects a selected root hidden by the existing skip contract", () => {
    const conflict = runScript(
      ["--package", "alpha"],
      { WASM_POSIX_FETCH_SKIP_PKGS: "alpha charlie" },
    );
    expect(conflict.status).toBe(2);
    expect(conflict.stderr).toMatch(
      /selected package 'alpha' is also listed in WASM_POSIX_FETCH_SKIP_PKGS/,
    );
    expect(logLines(/build-deps.*resolve/)).toEqual([]);

    const unrelated = runScript(
      ["--package", "bravo"],
      { WASM_POSIX_FETCH_SKIP_PKGS: "alpha" },
    );
    expect(unrelated.status, unrelated.stderr).toBe(0);
    expect(logLines(/build-deps.*resolve\s+bravo\b/).length).toBe(2);
    expect(logLines(/build-deps.*resolve\s+alpha\b/).length).toBe(0);
  });

  it.skipIf(!jqAvailable)(
    "materializes exactly the expected-ledger package/arch entries without a registry fallback",
    () => {
      const ledger = writeExpectedLedger(
        "expected-ledger.json",
        [
          { package: "bravo", arch: "wasm64" },
          { package: "alpha", arch: "wasm32" },
        ],
      );
      const { status, stdout, stderr } = runScript([
        "--fetch-only",
        "--expected-ledger",
        ledger,
      ]);
      expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

      expect(logLines(/build-deps.*resolve\s+alpha\b/).length).toBe(1);
      const bravoLines = logLines(/build-deps.*resolve\s+bravo\b/);
      expect(bravoLines).toHaveLength(1);
      expect(bravoLines[0]).toMatch(/--arch\s+wasm64/);
      expect(bravoLines[0]).not.toMatch(/--arch\s+wasm32/);
      expect(logLines(/build-deps.*resolve\s+charlie\b/)).toEqual([]);
      expect(logLines(/build-deps.*resolve\s+delta\b/)).toEqual([]);
      expect(stdout).toContain(
        "selected package/arch entries from expected ledger: bravo|wasm64 alpha|wasm32",
      );
      expect(stdout).toMatch(/resolved=2\s+total=2\s+skipped=0/);
      expect(
        logLines(/build-deps.*resolve\s+(?:alpha|bravo)\b/).every(
          (line) => /--fetch-only/.test(line),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!jqAvailable)(
    "rejects every ambiguous expected-ledger selection mode before resolving",
    () => {
      const ledger = writeExpectedLedger("selection-ledger.json", ["alpha"]);
      const cases: Array<{
        args: string[];
        env?: NodeJS.ProcessEnv;
        error: RegExp;
      }> = [
        {
          args: ["--expected-ledger", ledger, "--package", "alpha"],
          error: /--expected-ledger and --package are mutually exclusive/,
        },
        {
          args: ["--package=alpha", `--expected-ledger=${ledger}`],
          error: /--expected-ledger and --package are mutually exclusive/,
        },
        {
          args: ["--expected-ledger", ledger, "--expected-ledger", ledger],
          error: /--expected-ledger may be provided only once/,
        },
        {
          args: ["--expected-ledger", ""],
          error: /--expected-ledger requires a non-empty path/,
        },
        {
          args: ["--expected-ledger="],
          error: /--expected-ledger requires a non-empty path/,
        },
        {
          args: ["--expected-ledger"],
          error: /--expected-ledger requires a path/,
        },
      ];
      for (const testCase of cases) {
        const { status, stderr } = runScript(
          testCase.args,
          testCase.env ?? {},
        );
        expect(status, `${testCase.args.join(" ")}\n${stderr}`).toBe(2);
        expect(stderr).toMatch(testCase.error);
        expect(logLines(/build-deps.*resolve/)).toEqual([]);
      }
    },
  );

  it.skipIf(!jqAvailable)(
    "allows resolver skips to narrow a ledger without adding registry packages",
    () => {
      const ledger = writeExpectedLedger(
        "skip-ledger.json",
        ["alpha", "bravo"],
      );
      const { status, stdout, stderr } = runScript(
        ["--expected-ledger", ledger],
        { WASM_POSIX_FETCH_SKIP_PKGS: "bravo charlie" },
      );
      expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
      expect(logLines(/build-deps.*resolve\s+alpha\b/).length).toBe(1);
      expect(logLines(/build-deps.*resolve\s+bravo\b/)).toEqual([]);
      expect(logLines(/build-deps.*resolve\s+charlie\b/)).toEqual([]);
      expect(stdout).toContain(
        "ledger entry bravo (wasm32) omitted by WASM_POSIX_FETCH_SKIP_PKGS",
      );
      expect(stdout).toMatch(/resolved=1\s+total=1\s+skipped=0/);

      const skipAll = runScript(
        ["--expected-ledger", ledger],
        { WASM_POSIX_FETCH_SKIP_PKGS: "alpha bravo charlie" },
      );
      expect(skipAll.status).toBe(2);
      expect(skipAll.stderr).toMatch(
        /expected ledger selection is empty/,
      );
      expect(logLines(/build-deps.*resolve/)).toEqual([]);
    },
  );

  it.skipIf(!jqAvailable)(
    "rejects unknown, non-publishable, empty, and unsafe ledger roots",
    () => {
      const cases = [
        {
          ledger: writeExpectedLedger("missing-root-ledger.json", ["missing"]),
          error: /selected package 'missing' does not exist/,
        },
        {
          ledger: writeExpectedLedger("nonpublishable-ledger.json", ["delta"]),
          error: /selected package 'delta' has no publishable build\.toml/,
        },
        {
          ledger: writeExpectedLedger("empty-root-ledger.json", [""]),
          error: /requires a safe non-empty package name/,
        },
        {
          ledger: writeExpectedLedger("unsafe-root-ledger.json", ["../alpha"]),
          error: /requires a safe non-empty package name/,
        },
      ];
      for (const testCase of cases) {
        const { status, stderr } = runScript([
          "--expected-ledger",
          testCase.ledger,
        ]);
        expect(status, `${testCase.ledger}\n${stderr}`).toBe(2);
        expect(stderr).toMatch(testCase.error);
        expect(logLines(/build-deps.*resolve/)).toEqual([]);
      }
    },
  );

  it.skipIf(!jqAvailable)(
    "rejects malformed, empty, directory, and symlink ledgers without resolving",
    () => {
      const malformed = path.join(fakeRepoRoot, "malformed-ledger.json");
      writeFileSync(malformed, "{not json}\n");
      const empty = writeExpectedLedger("empty-ledger.json", []);
      const directory = path.join(fakeRepoRoot, "ledger-directory");
      mkdirSync(directory);
      const valid = writeExpectedLedger("linked-ledger-target.json", ["alpha"]);
      const linked = path.join(fakeRepoRoot, "linked-ledger.json");
      symlinkSync(valid, linked);
      const unsupportedArch = writeExpectedLedger(
        "unsupported-arch-ledger.json",
        [{ package: "alpha", arch: "native" }],
      );
      const undeclaredArch = writeExpectedLedger(
        "undeclared-arch-ledger.json",
        [{ package: "alpha", arch: "wasm64" }],
      );
      const duplicate = writeExpectedLedger(
        "duplicate-entry-ledger.json",
        ["alpha", "alpha"],
      );

      for (const ledger of [
        malformed,
        empty,
        directory,
        linked,
        unsupportedArch,
        undeclaredArch,
        duplicate,
      ]) {
        const { status, stderr } = runScript([
          "--expected-ledger",
          ledger,
        ]);
        expect(status, `${ledger}\n${stderr}`).toBe(2);
        if (ledger === undeclaredArch) {
          expect(stderr).toMatch(
            /expected ledger selects undeclared architecture alpha \(wasm64\)/,
          );
        } else {
          expect(stderr).toMatch(
            /expected ledger (?:is malformed or empty|must be a regular non-symlink file)/,
          );
        }
        expect(logLines(/build-deps.*resolve/)).toEqual([]);
      }
    },
  );

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

  it("--fetch-only passes the resolver source-build guard", () => {
    const { status, stdout, stderr } = runScript(["--fetch-only"]);
    expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    const alphaLines = logLines(/build-deps.*resolve\s+alpha\b/);
    expect(alphaLines.length).toBe(1);
    expect(alphaLines[0]).toMatch(/--fetch-only/);

    const bravoLines = logLines(/build-deps.*resolve\s+bravo\b/);
    expect(bravoLines.length).toBe(2);
    expect(bravoLines.every((l) => /--fetch-only/.test(l))).toBe(true);

    expect(stdout).toMatch(/--fetch-only enabled/);
  });

  it("skips kind=source packages under --fetch-only even with a build.toml", () => {
    // Regression gate for test-gate-prepare's "Materialize binaries"
    // step: it runs with --fetch-only, which forbids source builds.
    // wayland-protocols is kind=source yet carries a build.toml (for
    // its inputs cache-key), so a build.toml-only skip test would let
    // it through and the --fetch-only resolve would fail the run. The
    // skip must key off `kind = "source"`, not build.toml presence.
    const { status, stdout, stderr } = runScript(["--fetch-only"]);
    expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    // Never resolved — the guard fires before the arch loop.
    expect(logLines(/build-deps.*resolve\s+sourcepkg\b/).length).toBe(0);
    // Reported as a kind=source skip so CI logs explain the omission.
    expect(stdout).toMatch(/skip sourcepkg \(kind=source\)/);
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
    expect(r.stdout).toMatch(/--package <name>/);
    const normalizedHelp = r.stdout
      .replace(/^#\s?/gm, "")
      .replace(/\s+/g, " ");
    expect(normalizedHelp).toContain(
      "A self-contained published program can satisfy resolution before " +
        "its separately published dependencies are materialized. " +
        "Consumers that need those products must select those roots too.",
    );
  });
});
