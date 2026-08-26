import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function source(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("espeak-ng package contract", () => {
  it("pins both upstream archives by version and digest", () => {
    const manifest = source("packages/registry/espeak-ng/package.toml");
    const build = source("packages/registry/espeak-ng/build-espeak-ng.sh");

    expect(manifest).toContain('version = "1.52.0"');
    expect(manifest).toContain(
      'sha256 = "bb4338102ff3b49a81423da8a1a158b420124b055b60fa76cfb4b18677130a23"',
    );
    expect(build).toContain('PCAUDIO_VERSION="1.3"');
    expect(build).toContain(
      'PCAUDIO_SOURCE_SHA256="e8bd15f460ea171ccd0769ea432e188532a7fb27fa73ec2d526088a082abaaad"',
    );
    expect(build).toContain("shasum -a 256 -c -");
  });

  it("selects the OSS backend without patching either source tree", () => {
    const build = source("packages/registry/espeak-ng/build-espeak-ng.sh");

    expect(
      existsSync(join(repoRoot, "packages/registry/espeak-ng/patches")),
    ).toBe(false);
    expect(build).not.toMatch(/^\s*patch\b/m);
    expect(build).toContain("#define HAVE_SYS_SOUNDCARD_H 1");
    expect(build).not.toContain("HAVE_ALSA");
    expect(build).not.toContain("HAVE_PULSEAUDIO");
    expect(build).not.toContain("audio_kandelo");
  });

  it("generates the shipped data dir from the native tree, never the wasm one", () => {
    const build = source("packages/registry/espeak-ng/build-espeak-ng.sh");

    expect(build).toContain(
      'cmake --build "$NATIVE_BUILD_DIR" --target data',
    );
    expect(build).not.toContain(
      'cmake --build "$CROSS_BUILD_DIR" --target data',
    );
    expect(build).toContain(
      'python3 - "$NATIVE_BUILD_DIR/espeak-ng-data" "$DATA_ZIP"',
    );
  });

  it("declares every host tool the source build invokes", () => {
    const manifest = source("packages/registry/espeak-ng/package.toml");
    const build = source("packages/registry/espeak-ng/build-espeak-ng.sh");

    for (const tool of ["cmake", "curl", "tar", "shasum", "python3"]) {
      expect(manifest).toContain(`name = "${tool}"`);
    }
    expect(build).toContain("for tool in cmake curl tar shasum python3; do");
    expect(manifest).toContain('version_constraint = ">=7.71.0"');
  });

  it("resolves libcxx, which upstream builds unconditionally for speechPlayer", () => {
    const manifest = source("packages/registry/espeak-ng/package.toml");
    const build = source("packages/registry/espeak-ng/build-espeak-ng.sh");

    expect(manifest).toContain('depends_on = ["libcxx@21.1.7"]');
    expect(build).toContain("build-deps --arch=wasm32 resolve libcxx");
  });

  it("builds through the worktree SDK and publishes one wasm output", () => {
    const manifest = source("packages/registry/espeak-ng/package.toml");
    const build = source("packages/registry/espeak-ng/build-espeak-ng.sh");

    expect(build).toContain('source "$REPO_ROOT/sdk/activate.sh"');
    expect(build).toContain("WASM_POSIX_DEP_OUT_DIR");
    expect(manifest).toContain('wasm = "espeak-ng.wasm"');
  });

  it("publishes the voice data as a runtime file, never from the build tree", () => {
    const manifest = source("packages/registry/espeak-ng/package.toml");
    const build = source("packages/registry/espeak-ng/build-espeak-ng.sh");

    expect(manifest).toContain('artifact = "espeak-ng-data.zip"');
    expect(manifest).toContain(
      'guest_path = "/usr/share/espeak-ng/espeak-ng-data.zip"',
    );
    expect(build).toContain("install_local_runtime_file espeak-ng");

    // The projection moves a multi-member package under its own directory,
    // so consumers must name the closure paths rather than the flat ones.
    const projection = JSON.parse(
      source("packages/registry/program-packages.json"),
    ) as {
      packages: Record<string, { members: Array<{ mirrorPath: string }> }>;
    };
    expect(
      projection.packages["espeak-ng"]?.members.map((m) => m.mirrorPath),
    ).toEqual(["espeak-ng/espeak-ng.wasm", "espeak-ng/espeak-ng-data.zip"]);
  });

  it("builds the archive deterministically so the cache key follows the data", () => {
    const build = source("packages/registry/espeak-ng/build-espeak-ng.sh");

    expect(build).toContain("compression=zipfile.ZIP_STORED");
    expect(build).toContain("timestamp = (1980, 1, 1, 0, 0, 0)");
    expect(build).toContain("key=lambda item: item.as_posix()");
  });
});
