/**
 * End-to-end vitest test for the the binary release pipeline.
 *
 * Stages synthetic library + program archives via `cargo xtask
 * stage-release`, then installs them back via `cargo xtask
 * install-release` against `file://` URLs, and asserts the cache and
 * local-binaries directories are populated correctly. A third test
 * re-runs `xtask build-deps resolve` against the post-install cache
 * to confirm a cache HIT (the build script does NOT re-run — verified
 * by a sentinel file the script writes per invocation).
 *
 * The fixtures use plain bash (no SDK toolchain) so the test is
 * self-contained. The whole suite skips on machines without `rustc`
 * on PATH, mirroring the existing host-tool skip pattern in other
 * tests.
 *
 * Path semantics note (load-bearing):
 *   `install-release --cache-root <X>` puts archives at `<X>/libs/...`
 *   and `<X>/programs/...`. `build-deps resolve` reads its cache from
 *   `default_cache_root()`, which appends `wasm-posix-kernel` to
 *   `XDG_CACHE_HOME`. To make the two share a cache, we pass
 *   `--cache-root "$installCache/wasm-posix-kernel"` to install-release
 *   and `XDG_CACHE_HOME=$installCache` to build-deps resolve.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// host/test/ → repo root is two levels up.
const repoRoot = path.resolve(__dirname, "..", "..");

// Detect host triple via rustc; if rustc is missing, every test in
// this file should skip (matching the existing host-tool skip pattern).
let hostTriple: string | null = null;
try {
  hostTriple = execSync("rustc -vV", { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))!
    .split(/\s+/)[1];
} catch {
  hostTriple = null;
}

// Read the kernel ABI_VERSION from crates/shared so stage-release and
// install-release use the same value the resolver computes with
// (`current_abi_version()`). Hard-coding a different `--abi` would
// shift the canonical cache path's sha and the third test's
// cache-hit assertion would fail.
function readAbiVersion(): number {
  const src = readFileSync(
    path.join(repoRoot, "crates/shared/src/lib.rs"),
    "utf8",
  );
  const m = src.match(/pub const ABI_VERSION:\s*u32\s*=\s*(\d+)\s*;/);
  if (!m) {
    throw new Error("could not find ABI_VERSION in crates/shared/src/lib.rs");
  }
  return parseInt(m[1], 10);
}
const abiVersion = hostTriple !== null ? String(readAbiVersion()) : "0";

function cargoXtask(args: string[], env?: Record<string, string>): string {
  return execFileSync(
    "cargo",
    [
      "run",
      "-p",
      "xtask",
      "--target",
      hostTriple!,
      "--quiet",
      "--",
      ...args,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}

describe.skipIf(hostTriple === null)("release round-trip", () => {
  let registryRoot: string;
  let staging: string;
  let localBinaries: string;
  let sentinelDir: string;

  beforeAll(() => {
    registryRoot = mkdtempSync(path.join(tmpdir(), "wpk-rrt-reg-"));
    localBinaries = mkdtempSync(path.join(tmpdir(), "wpk-rrt-localbin-"));
    staging = mkdtempSync(path.join(tmpdir(), "wpk-rrt-stage-"));
    sentinelDir = mkdtempSync(path.join(tmpdir(), "wpk-rrt-sentinel-"));

    // Fixture: synthetic library `fixlib` whose build script writes
    // a single .a file. No SDK toolchain — pure bash. Each invocation
    // also writes a sentinel file so the cache-hit test can detect
    // whether the script re-ran.
    const libDir = path.join(registryRoot, "fixlib");
    mkdirSync(libDir, { recursive: true });
    writeFileSync(
      path.join(libDir, "package.toml"),
      [
        'kind = "library"',
        'name = "fixlib"',
        'version = "1.0.0"',
        "revision = 1",
        "[source]",
        'url = "file:///dev/null"',
        `sha256 = "${"0".repeat(64)}"`,
        "[license]",
        'spdx = "MIT"',
        "[outputs]",
        'libs = ["lib/libfix.a"]',
        'headers = ["include/fixlib.h"]',
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(libDir, "build-fixlib.sh"),
      [
        "#!/usr/bin/env bash",
        "set -e",
        // Sentinel: presence of any new file in WASM_POSIX_LOCAL_SENTINEL_DIR
        // proves this script ran on this invocation.
        'if [ -n "${WASM_POSIX_LOCAL_SENTINEL_DIR:-}" ]; then',
        '  date +%s%N > "${WASM_POSIX_LOCAL_SENTINEL_DIR}/fixlib-built.$$"',
        "fi",
        'mkdir -p "$WASM_POSIX_DEP_OUT_DIR/lib"',
        'mkdir -p "$WASM_POSIX_DEP_OUT_DIR/include"',
        'echo "fixture-archive-data" > "$WASM_POSIX_DEP_OUT_DIR/lib/libfix.a"',
        'echo "// fixlib header" > "$WASM_POSIX_DEP_OUT_DIR/include/fixlib.h"',
        "",
      ].join("\n"),
    );
    chmodSync(path.join(libDir, "build-fixlib.sh"), 0o755);

    // Fixture: synthetic program `fixprog` with a single output. The
    // build script emits the 8-byte minimal-valid wasm header
    // (4 bytes magic + 4 bytes version) — validate_outputs just checks
    // the file exists, but a valid header keeps any future stricter
    // check happy.
    const progDir = path.join(registryRoot, "fixprog");
    mkdirSync(progDir, { recursive: true });
    writeFileSync(
      path.join(progDir, "package.toml"),
      [
        'kind = "program"',
        'name = "fixprog"',
        'version = "1.0.0"',
        "revision = 1",
        "[source]",
        'url = "file:///dev/null"',
        `sha256 = "${"0".repeat(64)}"`,
        "[license]",
        'spdx = "MIT"',
        "[[outputs]]",
        'name = "fixprog"',
        'wasm = "fixprog.wasm"',
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(progDir, "build-fixprog.sh"),
      [
        "#!/usr/bin/env bash",
        "set -e",
        'printf "\\x00asm\\x01\\x00\\x00\\x00" > "$WASM_POSIX_DEP_OUT_DIR/fixprog.wasm"',
        "",
      ].join("\n"),
    );
    chmodSync(path.join(progDir, "build-fixprog.sh"), 0o755);
  }, 30_000);

  afterAll(() => {
    for (const d of [registryRoot, staging, localBinaries, sentinelDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  it("stage-release produces archives + manifest.json", () => {
    // Producer cache is per-test so we don't pollute the user's
    // ~/.cache between runs.
    const stageCache = mkdtempSync(path.join(tmpdir(), "wpk-rrt-stagecache-"));
    try {
      cargoXtask(
        [
          "stage-release",
          "--staging",
          staging,
          "--registry",
          registryRoot,
          "--cache-root",
          stageCache,
          "--abi",
          abiVersion,
          "--arch",
          "wasm32",
          "--build-timestamp",
          "2026-04-26T00:00:00Z",
          "--build-host",
          "fixture",
          "--continue-on-error",
        ],
        { WASM_POSIX_LOCAL_SENTINEL_DIR: sentinelDir },
      );

      // Lib archive present.
      const libArchives = readdirSync(path.join(staging, "libs"));
      expect(
        libArchives.find((f) => f.startsWith(`fixlib-1.0.0-rev1-abi${abiVersion}-wasm32-`)),
        `fixlib archive among ${JSON.stringify(libArchives)}`,
      ).toBeTruthy();
      expect(
        libArchives.find((f) => f.endsWith(".tar.zst")),
        "lib archive .tar.zst",
      ).toBeTruthy();

      // Program archive present.
      const progArchives = readdirSync(path.join(staging, "programs"));
      expect(
        progArchives.find((f) => f.startsWith(`fixprog-1.0.0-rev1-abi${abiVersion}-wasm32-`)),
        `fixprog archive among ${JSON.stringify(progArchives)}`,
      ).toBeTruthy();

      // Manifest contains both entries with package-system fields.
      const manifest = JSON.parse(
        readFileSync(path.join(staging, "manifest.json"), "utf8"),
      );
      const fixlibEntry = manifest.entries.find(
        (e: any) => e.program === "fixlib",
      );
      expect(fixlibEntry, "fixlib entry").toBeDefined();
      expect(fixlibEntry.kind).toBe("library");
      expect(fixlibEntry.archive_name).toBeDefined();
      expect(fixlibEntry.archive_sha256).toBeDefined();
      expect(fixlibEntry.compatibility).toBeDefined();
      expect(fixlibEntry.compatibility.target_arch).toBe("wasm32");
      expect(fixlibEntry.compatibility.abi_versions).toEqual([
        parseInt(abiVersion, 10),
      ]);

      const fixprogEntry = manifest.entries.find(
        (e: any) => e.program === "fixprog",
      );
      expect(fixprogEntry, "fixprog entry").toBeDefined();
      expect(fixprogEntry.kind).toBe("program");
      expect(fixprogEntry.archive_name).toBeDefined();
    } finally {
      try {
        rmSync(stageCache, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }, 180_000);

  it("install-release populates cache + mirrors program to local-binaries", () => {
    // Fresh cache so we're asserting the install fills it from scratch.
    const installCache = mkdtempSync(
      path.join(tmpdir(), "wpk-rrt-install-cache-"),
    );
    try {
      cargoXtask([
        "install-release",
        "--manifest",
        path.join(staging, "manifest.json"),
        "--archive-base",
        `file://${staging}`,
        "--cache-root",
        installCache,
        "--local-binaries-dir",
        localBinaries,
        "--registry",
        registryRoot,
        "--abi",
        abiVersion,
      ]);

      // Library landed in <cache>/libs/<canonical>/. Cache path uses
      // `<name>-<v>-rev<N>-<arch>-<shortsha>` (no abi slot — only the
      // release archive filename carries the abi slot).
      const libsDir = path.join(installCache, "libs");
      const libCanonical = readdirSync(libsDir).find((d) =>
        d.startsWith(`fixlib-1.0.0-rev1-wasm32-`),
      );
      expect(libCanonical, `fixlib canonical among ${readdirSync(libsDir)}`)
        .toBeTruthy();
      expect(
        existsSync(path.join(libsDir, libCanonical!, "lib/libfix.a")),
      ).toBe(true);
      expect(
        existsSync(path.join(libsDir, libCanonical!, "include/fixlib.h")),
      ).toBe(true);

      // Program archive landed in <cache>/programs/<canonical>/.
      const progsDir = path.join(installCache, "programs");
      const progCanonical = readdirSync(progsDir).find((d) =>
        d.startsWith(`fixprog-1.0.0-rev1-wasm32-`),
      );
      expect(progCanonical, `fixprog canonical among ${readdirSync(progsDir)}`)
        .toBeTruthy();
      expect(
        existsSync(path.join(progsDir, progCanonical!, "fixprog.wasm")),
      ).toBe(true);

      // Single-output program mirrored to
      // local-binaries/programs/<arch>/<name>.wasm. The per-arch
      // subtree is required so wasm32 and wasm64 builds of the same
      // program don't last-write-wins on a flat path.
      expect(
        existsSync(path.join(localBinaries, "programs", "wasm32", "fixprog.wasm")),
      ).toBe(true);
    } finally {
      try {
        rmSync(installCache, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }, 180_000);

  it("build-deps resolve hits the post-install cache (no rebuild)", () => {
    // Fresh install into a brand-new cache. Use the
    // XDG_CACHE_HOME/wasm-posix-kernel layout the resolver expects so
    // install-release and resolve agree on the cache location.
    const xdgCacheHome = mkdtempSync(path.join(tmpdir(), "wpk-rrt-xdg-"));
    const installCache = path.join(xdgCacheHome, "wasm-posix-kernel");
    mkdirSync(installCache, { recursive: true });
    const localBinHere = mkdtempSync(
      path.join(tmpdir(), "wpk-rrt-rh-localbin-"),
    );
    const sentinelHere = mkdtempSync(
      path.join(tmpdir(), "wpk-rrt-rh-sentinel-"),
    );
    try {
      cargoXtask([
        "install-release",
        "--manifest",
        path.join(staging, "manifest.json"),
        "--archive-base",
        `file://${staging}`,
        "--cache-root",
        installCache,
        "--local-binaries-dir",
        localBinHere,
        "--registry",
        registryRoot,
        "--abi",
        abiVersion,
      ]);

      // Now resolve fixlib via build-deps. With XDG_CACHE_HOME pointing
      // at the parent dir of the populated cache, the resolver should
      // HIT the cache and NOT invoke build-fixlib.sh — proven by zero
      // sentinel writes to sentinelHere.
      const sentinelsBefore = readdirSync(sentinelHere).length;
      const resolved = cargoXtask(
        ["build-deps", "resolve", "fixlib", "--arch", "wasm32"],
        {
          XDG_CACHE_HOME: xdgCacheHome,
          WASM_POSIX_DEPS_REGISTRY: registryRoot,
          WASM_POSIX_LOCAL_SENTINEL_DIR: sentinelHere,
        },
      ).trim();

      expect(resolved, "resolved path").toBeTruthy();
      expect(existsSync(resolved), `resolved path ${resolved} exists`).toBe(
        true,
      );
      // Critical assertion: build script did NOT run.
      const sentinelsAfter = readdirSync(sentinelHere).length;
      expect(
        sentinelsAfter,
        `sentinel count: build script ran ${
          sentinelsAfter - sentinelsBefore
        } extra time(s) after install — cache miss?`,
      ).toBe(sentinelsBefore);

      // The resolved path should match the canonical install location
      // (i.e. the resolver picked up the install-release artifact).
      expect(resolved.startsWith(installCache)).toBe(true);
    } finally {
      for (const d of [xdgCacheHome, localBinHere, sentinelHere]) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    }
  }, 240_000);
});
