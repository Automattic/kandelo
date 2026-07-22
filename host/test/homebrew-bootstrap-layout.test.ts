import { describe, expect, it } from "vitest";

import {
  HOMEBREW_BOOTSTRAP_GID,
  HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_PACKAGES,
  HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_OUTPUTS,
  HOMEBREW_BOOTSTRAP_LAYOUT,
  HOMEBREW_BOOTSTRAP_PREFIX,
  HOMEBREW_BOOTSTRAP_UID,
  homebrewBootstrapRootfsEagerArguments,
  renderHomebrewBootstrapLayoutJson,
  renderHomebrewBootstrapManifest,
  validateHomebrewBootstrapLayout,
  type HomebrewBootstrapArtifactKey,
} from "../../scripts/homebrew-bootstrap-layout";

const artifactKeys: HomebrewBootstrapArtifactKey[] = [
  "ruby",
  "git",
  "gitRemoteHttp",
  "curl",
  "tar",
  "gzip",
  "xz",
  "zstd",
  "bzip2",
];

function fixtureInput() {
  return {
    artifacts: Object.fromEntries(
      artifactKeys.map((key) => [key, `binaries/programs/wasm32/${key}.wasm`]),
    ) as Record<HomebrewBootstrapArtifactKey, string>,
    rubyRuntime: "binaries/programs/wasm32/ruby-runtime.zip",
    brewArchive: "target/homebrew-bootstrap/homebrew-brew.zip",
    brewEnvironment: "target/homebrew-bootstrap/brew.env",
    imageMetadata: "target/homebrew-bootstrap/homebrew-image.json",
    layoutMetadata: "target/homebrew-bootstrap/homebrew-bootstrap-layout.json",
  };
}

describe("Homebrew bootstrap guest layout", () => {
  it("describes the complete conventional entrypoint surface once", () => {
    expect(() => validateHomebrewBootstrapLayout()).not.toThrow();
    expect(HOMEBREW_BOOTSTRAP_LAYOUT.entrypoints.map(({ path }) => path)).toEqual([
      "/usr/bin/brew",
      "/usr/bin/ruby",
      "/usr/bin/gem",
      "/usr/bin/bundle",
      "/usr/bin/bundler",
    ]);
    expect(HOMEBREW_BOOTSTRAP_LAYOUT.entrypoints[0]).toMatchObject({
      kind: "symlink",
      target: `${HOMEBREW_BOOTSTRAP_PREFIX}/bin/brew`,
    });
    expect(
      HOMEBREW_BOOTSTRAP_LAYOUT.entrypoints.slice(2).every(
        ({ provider, kind }) => provider === "ruby-runtime" && kind === "ruby-script",
      ),
    ).toBe(true);
    expect(HOMEBREW_BOOTSTRAP_LAYOUT.eagerRootfsPackages).toEqual([
      ...HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_PACKAGES,
    ]);
    expect(HOMEBREW_BOOTSTRAP_LAYOUT.eagerRootfsOutputs).toEqual([
      ...HOMEBREW_BOOTSTRAP_EAGER_ROOTFS_OUTPUTS,
    ]);
    expect(homebrewBootstrapRootfsEagerArguments()).toEqual([
      "--eager-package", "dash",
      "--eager-package", "bash",
      "--eager-package", "coreutils",
      "--eager-package", "gawk",
      "--eager-package", "grep",
      "--eager-package", "sed",
      "--eager-package", "findutils",
      "--eager-output", "posix-utils-lite:/usr/bin/locale",
    ]);
  });

  it("separates mutable stock Homebrew state from protected initial provenance", () => {
    expect(HOMEBREW_BOOTSTRAP_LAYOUT.repository).toEqual({
      path: HOMEBREW_BOOTSTRAP_PREFIX,
      state: "mutable-working-repository",
      initialSourceProvenance: "/etc/kandelo/homebrew-image.json",
    });

    const writable = new Map(
      HOMEBREW_BOOTSTRAP_LAYOUT.writableDirectories.map((entry) => [entry.path, entry]),
    );
    for (const path of [
      HOMEBREW_BOOTSTRAP_PREFIX,
      `${HOMEBREW_BOOTSTRAP_PREFIX}/Cellar`,
      `${HOMEBREW_BOOTSTRAP_PREFIX}/Library/Taps`,
      `${HOMEBREW_BOOTSTRAP_PREFIX}/var/homebrew/locks`,
      "/home/linuxbrew/.cache/Homebrew",
      "/home/linuxbrew/.config/homebrew",
    ]) {
      expect(writable.has(path), path).toBe(true);
    }
    for (const entry of writable.values()) {
      const mode = Number.parseInt(entry.mode, 8);
      expect(mode & 0o022, `${entry.path} must not be group/world writable`).toBe(0);
    }
    expect(writable.get("/home/linuxbrew/.config/homebrew")?.mode).toBe("0700");

    expect(HOMEBREW_BOOTSTRAP_LAYOUT.protectedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/etc/kandelo/homebrew-image.json",
          owner: "root",
          mode: "0444",
        }),
        expect.objectContaining({
          path: "/etc/kandelo/homebrew-bootstrap-layout.json",
          owner: "root",
          mode: "0444",
        }),
      ]),
    );
  });

  it("renders the authoritative ownership and executable archive policy", () => {
    const manifest = renderHomebrewBootstrapManifest(fixtureInput());
    for (const directory of HOMEBREW_BOOTSTRAP_LAYOUT.writableDirectories) {
      expect(manifest).toContain(
        `${directory.path} d ${directory.mode} ${HOMEBREW_BOOTSTRAP_UID} ${HOMEBREW_BOOTSTRAP_GID}\n`,
      );
    }
    expect(manifest).toContain(
      "/etc/kandelo/homebrew-image.json f 0444 0 0 " +
        "src=target/homebrew-bootstrap/homebrew-image.json",
    );
    expect(manifest).toContain(
      "/usr/bin/brew l 0777 0 0 target=/home/linuxbrew/.linuxbrew/bin/brew",
    );
    expect(manifest).toContain(
      "/usr/bin/ruby f 0755 0 0 src=binaries/programs/wasm32/ruby.wasm",
    );
    expect(manifest).not.toContain("/usr/bin/bash ");
    expect(manifest).not.toContain("/usr/bin/env ");
    expect(manifest).toContain(
      "archive url=target/homebrew-bootstrap/homebrew-brew.zip " +
        "base=/home/linuxbrew/.linuxbrew fmode=0644 " +
        "fmode_policy=preserve-executable dmode=0755 uid=1000 gid=1000",
    );
    expect(manifest).toContain(
      "archive url=binaries/programs/wasm32/ruby-runtime.zip base=/ " +
        "fmode=0644 fmode_policy=preserve-executable dmode=0755 uid=0 gid=0",
    );
  });

  it("renders stable layout metadata and rejects unsafe source tokens", () => {
    expect(renderHomebrewBootstrapLayoutJson()).toBe(renderHomebrewBootstrapLayoutJson());
    expect(JSON.parse(renderHomebrewBootstrapLayoutJson())).toEqual(HOMEBREW_BOOTSTRAP_LAYOUT);

    const input = fixtureInput();
    input.artifacts.ruby = "../outside/ruby.wasm";
    expect(() => renderHomebrewBootstrapManifest(input)).toThrow(
      /canonical relative manifest source/,
    );
  });
});
