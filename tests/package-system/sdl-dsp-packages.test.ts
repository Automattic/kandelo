import { existsSync, readFileSync } from "node:fs";
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

describe("SDL_mixer playwave /dev/dsp integration fixture", () => {
  it("pins the official SDL_mixer 2.8.2 source and SDL2 dependency", () => {
    const manifest = source(
      "packages/registry/sdl2-mixer-playwave/package.toml",
    );

    expect(manifest).toContain('version = "2.8.2"');
    expect(manifest).toContain(
      'url = "https://github.com/libsdl-org/SDL_mixer/releases/download/release-2.8.2/SDL2_mixer-2.8.2.tar.gz"',
    );
    expect(manifest).toContain(
      'sha256 = "938dff531d00ace2296557a6599abe6f34599e2f34f0a4a08a397e2ccac8b8f7"',
    );
    expect(manifest).toContain('depends_on = ["sdl2@2.32.10"]');
    expect(manifest).toContain('name = "playwave"');
    expect(manifest).toContain('wasm = "playwave.wasm"');
  });

  it("declares every host tool used by the source build", () => {
    const manifest = source(
      "packages/registry/sdl2-mixer-playwave/package.toml",
    );

    for (const tool of ["make", "curl", "tar", "shasum"]) {
      expect(manifest).toContain(`name = "${tool}"`);
    }
    expect(manifest).toContain('version_constraint = ">=7.71.0"');
  });

  it("builds unmodified upstream playwave with only WAVE support", () => {
    const build = source(
      "packages/registry/sdl2-mixer-playwave/build-sdl2-mixer-playwave.sh",
    );

    expect(
      existsSync(join(repoRoot, "packages/registry/sdl2-mixer-playwave/patches")),
    ).toBe(false);
    expect(build).not.toMatch(/\bpatch\b/);
    expect(build).toContain('source "$REPO_ROOT/sdk/activate.sh"');
    expect(build).toContain("WASM_POSIX_DEP_OUT_DIR");
    expect(build).toContain("WASM_POSIX_DEP_SDL2_DIR");
    expect(build).toContain("--enable-music-wave");
    for (const decoder of [
      "cmd",
      "mod",
      "midi",
      "gme",
      "ogg",
      "flac",
      "mp3",
      "opus",
      "wavpack",
    ]) {
      expect(build).toContain(`--disable-music-${decoder}`);
    }
    expect(build).toContain("make -j");
    expect(build).toContain("build/playwave");
    expect(build).toContain("scripts/run-wasm-fork-instrument.sh");
  });
});
