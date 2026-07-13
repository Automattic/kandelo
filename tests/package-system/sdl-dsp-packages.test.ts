import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("SDL OSS package recipes", () => {
  it("pins the official SDL2 and SDL3 release archives", () => {
    const sdl2 = source("packages/registry/sdl2/package.toml");
    const sdl3 = source("packages/registry/sdl3/package.toml");

    expect(sdl2).toContain('version = "2.32.10"');
    expect(sdl2).toContain(
      'sha256 = "5f5993c530f084535c65a6879e9b26ad441169b3e25d789d83287040a9ca5165"',
    );
    expect(sdl3).toContain('version = "3.4.10"');
    expect(sdl3).toContain(
      'sha256 = "12b34280415ec8418c864408b93d008a20a6530687ee613d60bfbd20411f2785"',
    );
  });

  it("limits upstream patches to truthful Kandelo platform detection", () => {
    for (const patch of [
      "packages/registry/sdl2/patches/0001-recognize-kandelo-as-unix.patch",
      "packages/registry/sdl3/patches/0001-recognize-kandelo-platform.patch",
    ]) {
      const text = source(patch);
      expect(text).toMatch(/kandelo/i);
      expect(text).not.toMatch(/^diff --git a\/src\/audio\/dsp\//m);
    }
    const sdl2Patch = source(
      "packages/registry/sdl2/patches/0001-recognize-kandelo-as-unix.patch",
    );
    expect(sdl2Patch).toContain("wasm32-*-none*");
    expect(sdl2Patch).not.toContain("+    *-*-none*");
  });

  it("declares its versioned host build tools for resolver preflight", () => {
    const sdl2 = source("packages/registry/sdl2/package.toml");
    const sdl3 = source("packages/registry/sdl3/package.toml");

    for (const tool of ["curl", "tar", "patch", "shasum"]) {
      expect(sdl2).toContain(`name = "${tool}"`);
      expect(sdl3).toContain(`name = "${tool}"`);
    }
    expect(sdl2).toContain('name = "make"');
    expect(sdl3).toContain('name = "cmake"');
    // Both source recipes use curl's --retry-all-errors, introduced in 7.71.0.
    expect(sdl2).toContain('version_constraint = ">=7.71.0"');
    expect(sdl3).toContain('version_constraint = ">=7.71.0"');
  });

  it("builds static OSS-only libraries through the worktree SDK", () => {
    const sdl2 = source("packages/registry/sdl2/build-sdl2.sh");
    const sdl3 = source("packages/registry/sdl3/build-sdl3.sh");

    for (const script of [sdl2, sdl3]) {
      expect(script).toContain('source "$REPO_ROOT/sdk/activate.sh"');
      expect(script).toContain("WASM_POSIX_DEP_OUT_DIR");
      expect(script).toContain("ffile-prefix-map");
    }
    expect(sdl2).toContain("--enable-oss");
    expect(sdl2).toContain("--disable-alsa");
    expect(sdl2).toContain("--disable-pulseaudio");
    expect(sdl2).toContain("CXX=wasm32posix-c++");
    expect(sdl2).toContain("NM=wasm32posix-nm");
    expect(sdl2).toContain("STRIP=wasm32posix-strip");
    expect(sdl2).toContain("ac_cv_func_sysctlbyname=no");
    expect(sdl3).toContain("-DSDL_OSS=ON");
    expect(sdl3).toContain("-DSDL_UNIX_CONSOLE_BUILD=ON");
    expect(sdl3).toContain("-DSDL_ALSA=OFF");
    expect(sdl3).toContain("-DSDL_PULSEAUDIO=OFF");
    const sdl3Toolchain = source(
      "packages/registry/sdl3/cmake/kandelo-toolchain.cmake",
    );
    expect(sdl3Toolchain).toContain("set(CMAKE_NM wasm32posix-nm)");
    expect(sdl3Toolchain).toContain("set(CMAKE_STRIP wasm32posix-strip)");
  });
});

describe("SDL /dev/dsp integration fixture", () => {
  it("declares both upstream-version test executables", () => {
    const manifest = source("packages/registry/sdl-dsp-test/package.toml");
    expect(manifest).toContain('depends_on = ["sdl2@2.32.10", "sdl3@3.4.10"]');
    expect(manifest).toContain('wasm = "sdl2-dsp-test.wasm"');
    expect(manifest).toContain('wasm = "sdl3-dsp-test.wasm"');
  });

  it("forces dsp, reports JSON pacing data, and instruments final Wasm", () => {
    const build = source(
      "packages/registry/sdl-dsp-test/build-sdl-dsp-test.sh",
    );
    const sdl2 = source("packages/registry/sdl-dsp-test/src/sdl2-dsp-test.c");
    const sdl3 = source("packages/registry/sdl-dsp-test/src/sdl3-dsp-test.c");

    expect(build).toContain("scripts/run-wasm-fork-instrument.sh");
    for (const fixture of [sdl2, sdl3]) {
      expect(fixture).toContain('setenv("SDL_AUDIODRIVER", "dsp", 1)');
      expect(fixture).toContain("SDL_DSP_RESULT ");
      expect(fixture).toContain('\\"pcm_bytes\\":%llu');
      expect(fixture).toContain('\\"close_ms\\":%llu');
    }
    expect(sdl2).toContain("requested.freq = 22050");
    expect(sdl2).toContain("requested.format = AUDIO_U8");
    expect(sdl3).toContain("requested.freq = 48000");
    expect(sdl3).toContain("requested.format = SDL_AUDIO_S16LE");
    expect(sdl3).toContain("#ifndef SDL_PLATFORM_UNIX");
  });
});
