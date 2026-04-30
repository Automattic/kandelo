/**
 * Unit-ish test for `scripts/fetch-binaries.sh --allow-stale`.
 *
 * Exercises the flag parser, the install-release invocation that gets
 * --allow-stale-manifest + --stale-out appended, the JSON-driven loop
 * that calls `xtask build-deps resolve` for each stale entry, and the
 * summary print. Does NOT touch real cargo / xtask / build scripts —
 * those paths are exercised by Task 5's end-to-end smoke test.
 *
 * Strategy: stage a fake "repo root" in a tempdir with a hand-written
 * binaries.lock + manifest.json (manifest is pre-placed in
 * binaries/objects/ at its sha so the download is skipped), then put a
 * fake `cargo` script first on PATH. The fake cargo logs every
 * invocation and, when called with `install-release ... --stale-out
 * <path>`, writes a canned StaleEntry array to <path>. We then assert
 * the command lines look right.
 *
 * If rustc isn't on PATH we skip — the script calls `rustc -vV` to
 * compute HOST_TARGET, and there's no good reason to shim that too.
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
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// host/test/ → repo root is two levels up.
const repoRoot = path.resolve(__dirname, "..", "..");

let rustcAvailable = true;
try {
  execFileSync("rustc", ["-vV"], { encoding: "utf8" });
} catch {
  rustcAvailable = false;
}

function sha256Hex(buf: Buffer | string): string {
  const h = createHash("sha256");
  h.update(buf);
  return h.digest("hex");
}

describe.skipIf(!rustcAvailable)("fetch-binaries.sh --allow-stale", () => {
  let fakeRepoRoot: string;
  let fakeBinDir: string;
  let cargoLogPath: string;
  let stalePayloadPath: string;

  /**
   * Set up a fake "repo root" with:
   *   <root>/binaries.lock
   *   <root>/binaries/objects/<manifestSha>.json    (the manifest)
   *   <root>/scripts/fetch-binaries.sh              (copy of the real script)
   *   <root>/fake-bin/cargo                          (PATH shim)
   *
   * The manifest is hand-built and contains exactly one archive-style
   * entry, so install-release runs but Step 2's loop does nothing
   * (archive entries are skipped by the `continue` at line ~250).
   *
   * stalePayload is the JSON array the fake cargo will write to
   * --stale-out. The test asserts the script then runs build-deps for
   * each entry in the payload.
   */
  beforeAll(() => {
    fakeRepoRoot = mkdtempSync(path.join(tmpdir(), "wpk-fbas-"));
    fakeBinDir = path.join(fakeRepoRoot, "fake-bin");
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(path.join(fakeRepoRoot, "scripts"), { recursive: true });
    mkdirSync(path.join(fakeRepoRoot, "binaries", "objects"), {
      recursive: true,
    });

    // Synthesize a minimal manifest with one archive entry.
    const manifestObj = {
      abi_version: 6,
      release_tag: "binaries-abi-v6-fake",
      generated_at: "2026-04-29T00:00:00Z",
      entries: [
        {
          archive_name: "fakelib-wasm32.tar.zst",
          archive_sha256: "0".repeat(64),
          program: "fakelib",
          arch: "wasm32",
          kind: "lib",
          compatibility: {
            cache_key_sha: "1".repeat(64),
          },
        },
      ],
    };
    const manifestBytes = Buffer.from(
      JSON.stringify(manifestObj, null, 2),
      "utf8",
    );
    const manifestSha = sha256Hex(manifestBytes);
    writeFileSync(
      path.join(fakeRepoRoot, "binaries", "objects", `${manifestSha}.json`),
      manifestBytes,
    );

    // binaries.lock pointing at the manifest we just placed.
    const lockObj = {
      abi_version: 6,
      release_tag: "binaries-abi-v6-fake",
      manifest_sha256: manifestSha,
    };
    writeFileSync(
      path.join(fakeRepoRoot, "binaries.lock"),
      JSON.stringify(lockObj, null, 2),
    );

    // Copy the real fetch-binaries.sh so it computes
    // REPO_ROOT=fakeRepoRoot via "$(cd "$(dirname "$0")/.." && pwd)".
    copyFileSync(
      path.join(repoRoot, "scripts", "fetch-binaries.sh"),
      path.join(fakeRepoRoot, "scripts", "fetch-binaries.sh"),
    );
    chmodSync(path.join(fakeRepoRoot, "scripts", "fetch-binaries.sh"), 0o755);

    // Logs / payload paths — outside the fake repo so cleanup is
    // independent.
    cargoLogPath = path.join(fakeRepoRoot, "cargo.log");
    stalePayloadPath = path.join(fakeRepoRoot, "stale-payload.json");

    // The canned stale-payload the fake cargo will write when it sees
    // --stale-out. Two entries to verify the build-deps loop iterates
    // (and only logs one summary line).
    const stalePayload = [
      { program: "alpha", arch: "wasm32", local_sha: "a".repeat(64) },
      { program: "beta", arch: "wasm64", local_sha: "b".repeat(64) },
    ];
    writeFileSync(stalePayloadPath, JSON.stringify(stalePayload));

    // Fake cargo: log every invocation, copy stalePayload to --stale-out
    // when present. POSIX shell: easy to read, no escape-hatch needed.
    const fakeCargo = `#!/usr/bin/env bash
# Test shim. Logs all args; on install-release with --stale-out, copies
# the canned payload. On build-deps, just records the call.
echo "$@" >> "$CARGO_LOG"
mode=""
stale_out=""
seen_install=0
seen_build=0
while [ $# -gt 0 ]; do
    case "$1" in
        install-release) seen_install=1 ;;
        build-deps) seen_build=1 ;;
        --stale-out) stale_out="$2" ;;
    esac
    shift
done
if [ "$seen_install" = "1" ] && [ -n "$stale_out" ]; then
    cp "$STALE_PAYLOAD" "$stale_out"
fi
if [ "$seen_build" = "1" ]; then
    echo "fake build-deps OK"
fi
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
  ): { status: number | null; stdout: string; stderr: string } {
    // Reset the cargo log so each test sees only its own invocations.
    writeFileSync(cargoLogPath, "");
    const env = {
      ...process.env,
      // Prepend fake-bin so our shim wins over a real `cargo` install.
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      CARGO_LOG: cargoLogPath,
      STALE_PAYLOAD: stalePayloadPath,
    };
    const r = spawnSync(
      "bash",
      [path.join(fakeRepoRoot, "scripts", "fetch-binaries.sh"), ...extraArgs],
      { cwd: fakeRepoRoot, encoding: "utf8", env },
    );
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  it("without --allow-stale: install-release gets no stale flags, no build-deps loop", () => {
    const { status, stdout, stderr } = runScript([]);
    expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    const log = readFileSync(cargoLogPath, "utf8");
    // install-release was called.
    expect(log).toMatch(/install-release/);
    // No stale-out / allow-stale-manifest flags.
    expect(log).not.toMatch(/--allow-stale-manifest/);
    expect(log).not.toMatch(/--stale-out/);
    // No build-deps invocations.
    expect(log).not.toMatch(/build-deps/);
    // No "stale manifests" summary.
    expect(stdout + stderr).not.toMatch(/stale manifests/);
  });

  it("with --allow-stale: install-release gets the flags, build-deps runs per stale entry, summary prints", () => {
    const { status, stdout, stderr } = runScript(["--allow-stale"]);
    expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    const log = readFileSync(cargoLogPath, "utf8");

    // install-release line includes both stale flags.
    const installLine = log
      .split("\n")
      .find((l) => l.includes("install-release"));
    expect(installLine, `log:\n${log}`).toBeTruthy();
    expect(installLine!).toMatch(/--allow-stale-manifest/);
    expect(installLine!).toMatch(/--stale-out\s+\S+/);
    // Standard install-release args still present.
    expect(installLine!).toMatch(/--manifest\s+\S+/);
    expect(installLine!).toMatch(/--archive-base\s+\S+/);
    expect(installLine!).toMatch(/--binaries-dir\s+\S+/);

    // build-deps was called once per stale entry, with the right
    // --arch and program name.
    const buildLines = log
      .split("\n")
      .filter((l) => l.includes("build-deps"));
    expect(buildLines.length).toBe(2);
    expect(buildLines.some((l) => /--arch\s+wasm32\s+resolve\s+alpha/.test(l)))
      .toBe(true);
    expect(buildLines.some((l) => /--arch\s+wasm64\s+resolve\s+beta/.test(l)))
      .toBe(true);

    // Summary printed (script writes to stdout, not stderr).
    const combined = stdout + stderr;
    expect(combined).toMatch(/2 package\(s\) had stale manifests/);
    expect(combined).toMatch(/source-build complete/);
  });

  it("with --allow-stale but no stale entries: skips the build-deps loop and the summary", () => {
    // Overwrite the canned payload with an empty array.
    writeFileSync(stalePayloadPath, "[]");
    try {
      const { status, stdout, stderr } = runScript(["--allow-stale"]);
      expect(status, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

      const log = readFileSync(cargoLogPath, "utf8");
      // install-release still gets the flags.
      expect(log).toMatch(/--allow-stale-manifest/);
      // No build-deps invocations.
      expect(log).not.toMatch(/build-deps/);
      // No summary print.
      expect(stdout + stderr).not.toMatch(/had stale manifests/);
    } finally {
      // Restore the non-empty payload so other tests in this file
      // wouldn't see the empty version (defensive — only one other
      // test runs after this one's setup, and beforeAll already
      // re-stages anyway).
      const restored = [
        { program: "alpha", arch: "wasm32", local_sha: "a".repeat(64) },
        { program: "beta", arch: "wasm64", local_sha: "b".repeat(64) },
      ];
      writeFileSync(stalePayloadPath, JSON.stringify(restored));
    }
  });

  it("--help mentions --allow-stale", () => {
    const r = spawnSync(
      "bash",
      [path.join(fakeRepoRoot, "scripts", "fetch-binaries.sh"), "--help"],
      { cwd: fakeRepoRoot, encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/--allow-stale\s/);
  });
});
