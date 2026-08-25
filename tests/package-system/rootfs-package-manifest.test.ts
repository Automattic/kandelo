import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../host/src/vfs/memory-fs";
import {
  EXPERIMENTAL_TERMINAL_SESSION_PATH,
  parseExperimentalTerminalSession,
} from "../../web-libs/kandelo-session/src/experimental-terminal-session";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const generator = join(
  repoRoot,
  "scripts",
  "generate-rootfs-package-manifest.mjs",
);
const scratchRoots: string[] = [];

function makeScratch(): string {
  const target = join(repoRoot, "target");
  mkdirSync(target, { recursive: true });
  const scratch = mkdtempSync(join(target, "manifest-provenance-"));
  scratchRoots.push(scratch);
  return scratch;
}

function writeArtifact(root: string, rel: string, bytes: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function runGenerator(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [generator, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function makeRootfsBuildFixture() {
  const scratch = makeScratch();
  const selectedRoot = join(scratch, "selected-binaries");
  const binaryRel = "programs/wasm32/fixture.wasm";
  const binary = writeArtifact(selectedRoot, binaryRel, "fixture-bytes");
  const packages = join(scratch, "PACKAGES.toml");
  writeFileSync(
    packages,
    [
      'default_install = "lazy"',
      'lazy_url_prefix = "binaries/"',
      "[[packages]]",
      'name = "fixture"',
      "[[packages.outputs]]",
      `binary = "${binaryRel}"`,
      'path = "/usr/bin/fixture"',
      "",
    ].join("\n"),
  );
  return {
    scratch,
    binary,
    binaryRel,
    commonEnv: {
      ...process.env,
      ROOTFS_PACKAGES_CONFIG: packages,
      ROOTFS_BINARIES_DIR: selectedRoot,
      ROOTFS_SKIP_PACKAGE_RESOLVE: "1",
      ROOTFS_SEALED_BUILD: "1",
    },
  };
}

afterEach(() => {
  for (const root of scratchRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("generate-rootfs-package-manifest artifact provenance", () => {
  it("keeps login eager while sudo implementations remain lazy", () => {
    const packages = readFileSync(
      join(repoRoot, "images", "rootfs", "PACKAGES.toml"),
      "utf8",
    );
    const loginBlock = packages.match(
      /\[\[packages\]\]\s*name = "login"[\s\S]*?(?=\[\[packages\]\]|$)/,
    )?.[0];
    const sudoLiteBlock = packages.match(
      /\[\[packages\]\]\s*name = "sudo-lite"[\s\S]*?(?=\[\[packages\]\]|$)/,
    )?.[0];
    const sudoBlock = packages.match(
      /\[\[packages\]\]\s*name = "sudo"[\s\S]*?(?=\[\[packages\]\]|$)/,
    )?.[0];

    expect(loginBlock).toContain('install = "eager"');
    expect(loginBlock).toContain('path = "/usr/bin/login"');
    expect(loginBlock).toContain('mode = "4755"');
    expect(sudoLiteBlock).not.toContain('install = "eager"');
    expect(sudoLiteBlock).toContain('path = "/usr/bin/sudo-lite"');
    expect(sudoLiteBlock).toContain('mode = "4755"');
    expect(sudoBlock).not.toContain('install = "eager"');
    expect(sudoBlock).toContain('path = "/usr/bin/sudo"');
    expect(sudoBlock).toContain('mode = "4755"');
  });

  it("owns the experimental auto-login policy in the rootfs image", () => {
    const configPath = join(
      repoRoot,
      "images",
      "rootfs",
      EXPERIMENTAL_TERMINAL_SESSION_PATH.slice(1),
    );
    const config = parseExperimentalTerminalSession(
      readFileSync(configPath, "utf8"),
    );

    expect(config.initial).toEqual({
      path: "/usr/bin/login",
      argv: ["login", "-p", "-f", "maker"],
      uid: 0,
      gid: 0,
    });
    expect(config.afterExit).toEqual({
      path: "/usr/bin/login",
      argv: ["login", "-p"],
      uid: 0,
      gid: 0,
    });
    expect(readFileSync(join(repoRoot, "MANIFEST"), "utf8")).toContain(
      `${EXPERIMENTAL_TERMINAL_SESSION_PATH} f 0644 0 0`,
    );
  });

  it("uses an exact resolved-output map without materializing lazy bytes", () => {
    const scratch = makeScratch();
    const embedded = writeArtifact(scratch, "inputs/eager.dat", "eager-bytes");
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        'default_install = "lazy"',
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        'binary = "programs/wasm32/lazy.wasm"',
        'path = "/usr/bin/lazy"',
        "[[packages.outputs]]",
        'binary = "programs/wasm32/eager.dat"',
        'path = "/usr/share/eager.dat"',
        'install = "eager"',
        'mode = "0644"',
        "",
      ].join("\n"),
    );
    const lazySha256 = sha256("lazy-bytes-are-not-present");
    const embeddedSha256 = sha256("eager-bytes");
    const resolved = join(scratch, "resolved.json");
    writeFileSync(
      resolved,
      canonicalJson({
        kind: "kandelo-rootfs-resolved-package-outputs",
        outputs: [
          {
            bytes: 11,
            id: "package-fixture-output-eager",
            materialization: "embedded",
            path: embedded,
            sha256: embeddedSha256,
          },
          {
            bytes: 26,
            id: "package-fixture-output-lazy",
            materialization: "lazy-reference",
            reference: `https://artifacts.example.test/lazy.wasm?sha256=${lazySha256}`,
            sha256: lazySha256,
          },
        ],
        schema: 1,
      }),
    );
    const out = join(scratch, "resolved.MANIFEST");

    const result = runGenerator([
      "--packages", packages,
      "--resolved-output-map", resolved,
      "--out", out,
    ]);

    expect(result.status, result.stderr).toBe(0);
    const manifest = readFileSync(out, "utf8");
    expect(manifest).toContain(
      `lazy_url=https://artifacts.example.test/lazy.wasm?sha256=${lazySha256} lazy_size=26`,
    );
    expect(manifest).toContain(
      `/usr/share/eager.dat f 0644 0 0 src=${embedded}`,
    );
    expect(manifest).not.toContain("programs/wasm32/lazy.wasm");

    const parsed = JSON.parse(readFileSync(resolved, "utf8"));
    parsed.outputs.push({
      bytes: 1,
      id: "package-undeclared-output-extra",
      materialization: "lazy-reference",
      reference: `https://artifacts.example.test/extra?sha256=${"f".repeat(64)}`,
      sha256: "f".repeat(64),
    });
    writeFileSync(resolved, canonicalJson(parsed));
    const extra = runGenerator([
      "--packages", packages,
      "--resolved-output-map", resolved,
      "--out", join(scratch, "extra.MANIFEST"),
    ]);
    expect(extra.status).toBe(1);
    expect(extra.stderr).toContain("unconsumed resolved package output");
  });

  it("stages exact resolver dependency outputs into a fresh private tree", () => {
    const scratch = makeScratch();
    const dependencyRoot = join(scratch, "fixture-dependency");
    writeArtifact(dependencyRoot, "fixture.wasm", "wasm-bytes");
    writeArtifact(dependencyRoot, "runtime.dat", "runtime-bytes");
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        'lazy_url_prefix = "binaries/"',
        "[[packages]]",
        'name = "fixture-package"',
        "[[packages.outputs]]",
        'binary = "programs/wasm32/fixture-package/fixture.wasm"',
        'path = "/usr/bin/fixture"',
        "[[packages.outputs]]",
        'binary = "programs/wasm32/fixture-package/renamed.dat"',
        'source_artifact = "runtime.dat"',
        'path = "/usr/share/fixture/runtime.dat"',
        'install = "eager"',
        'mode = "0644"',
        "",
      ].join("\n"),
    );
    const stageRoot = join(scratch, "resolver-stage");
    const out = join(scratch, "resolver.MANIFEST");

    const result = runGenerator(
      [
        "--packages",
        packages,
        "--stage-resolver-binaries",
        stageRoot,
        "--out",
        out,
      ],
      {
        WASM_POSIX_DEP_FIXTURE_PACKAGE_DIR: dependencyRoot,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(
        join(
          stageRoot,
          "programs/wasm32/fixture-package/fixture.wasm",
        ),
        "utf8",
      ),
    ).toBe("wasm-bytes");
    expect(
      readFileSync(
        join(stageRoot, "programs/wasm32/fixture-package/renamed.dat"),
        "utf8",
      ),
    ).toBe("runtime-bytes");
    const manifest = readFileSync(out, "utf8");
    expect(manifest).toContain(
      "lazy_url=binaries/programs/wasm32/fixture-package/fixture.wasm lazy_size=10",
    );
    expect(manifest).toContain(`src=${relative(
      repoRoot,
      join(stageRoot, "programs/wasm32/fixture-package/renamed.dat"),
    )}`);
  });

  it("requires a fresh stage and the exact declared dependency environment", () => {
    const scratch = makeScratch();
    const dependencyRoot = join(scratch, "fixture-dependency");
    writeArtifact(dependencyRoot, "fixture.wasm", "bytes");
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        'binary = "programs/wasm32/fixture.wasm"',
        'path = "/usr/bin/fixture"',
        "",
      ].join("\n"),
    );

    const missing = runGenerator([
      "--packages",
      packages,
      "--stage-resolver-binaries",
      join(scratch, "missing-env-stage"),
      "--out",
      join(scratch, "missing-env.MANIFEST"),
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("WASM_POSIX_DEP_FIXTURE_DIR is required");

    const occupiedStage = join(scratch, "occupied-stage");
    mkdirSync(occupiedStage);
    const occupied = runGenerator(
      [
        "--packages",
        packages,
        "--stage-resolver-binaries",
        occupiedStage,
        "--out",
        join(scratch, "occupied.MANIFEST"),
      ],
      { WASM_POSIX_DEP_FIXTURE_DIR: dependencyRoot },
    );
    expect(occupied.status).toBe(1);
    expect(occupied.stderr).toContain(
      "refusing to reuse staged artifacts",
    );
  });

  it("rejects a linked resolver artifact rather than following it", () => {
    const scratch = makeScratch();
    const dependencyRoot = join(scratch, "fixture-dependency");
    mkdirSync(dependencyRoot);
    const external = writeArtifact(scratch, "external.wasm", "outside");
    symlinkSync(external, join(dependencyRoot, "fixture.wasm"));
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        'binary = "programs/wasm32/fixture.wasm"',
        'path = "/usr/bin/fixture"',
        "",
      ].join("\n"),
    );

    const result = runGenerator(
      [
        "--packages",
        packages,
        "--stage-resolver-binaries",
        join(scratch, "resolver-stage"),
        "--out",
        join(scratch, "resolver.MANIFEST"),
      ],
      { WASM_POSIX_DEP_FIXTURE_DIR: dependencyRoot },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "resolver artifact must be a regular file, not a link",
    );
  });

  it("rejects a linked resolver dependency root rather than trusting its target", () => {
    const scratch = makeScratch();
    const dependencyRoot = join(scratch, "fixture-dependency");
    writeArtifact(dependencyRoot, "fixture.wasm", "bytes");
    const linkedRoot = join(scratch, "linked-dependency");
    symlinkSync(dependencyRoot, linkedRoot);
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        'binary = "programs/wasm32/fixture.wasm"',
        'path = "/usr/bin/fixture"',
        "",
      ].join("\n"),
    );

    const result = runGenerator(
      [
        "--packages",
        packages,
        "--stage-resolver-binaries",
        join(scratch, "resolver-stage"),
        "--out",
        join(scratch, "resolver.MANIFEST"),
      ],
      { WASM_POSIX_DEP_FIXTURE_DIR: linkedRoot },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "WASM_POSIX_DEP_FIXTURE_DIR must name a real directory, not a link",
    );
  });

  it("rejects a source_artifact that escapes its resolver dependency root", () => {
    const scratch = makeScratch();
    const dependencyRoot = join(scratch, "fixture-dependency");
    writeArtifact(dependencyRoot, "fixture.wasm", "bytes");
    writeArtifact(scratch, "outside.wasm", "outside");
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        'binary = "programs/wasm32/fixture.wasm"',
        'source_artifact = "../outside.wasm"',
        'path = "/usr/bin/fixture"',
        "",
      ].join("\n"),
    );

    const result = runGenerator(
      [
        "--packages",
        packages,
        "--stage-resolver-binaries",
        join(scratch, "resolver-stage"),
        "--out",
        join(scratch, "resolver.MANIFEST"),
      ],
      { WASM_POSIX_DEP_FIXTURE_DIR: dependencyRoot },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "source_artifact must be a canonical NFC relative POSIX path",
    );
    expect(result.stderr).not.toContain("outside");
  });

  it.each([
    ["output", "resolver output root"],
    ["work", "resolver work root"],
  ] as const)(
    "rejects a resolver %s root in the checkout before mutating it",
    (repoRootKind, errorLabel) => {
      const checkoutRoot = makeScratch();
      const externalRoot = mkdtempSync(
        join(tmpdir(), "kandelo-rootfs-wrapper-"),
      );
      scratchRoots.push(externalRoot);
      const repoBound = join(checkoutRoot, repoRootKind);
      const external = join(externalRoot, "resolver-root");
      mkdirSync(repoBound);
      mkdirSync(external);
      writeFileSync(join(repoBound, "sentinel"), "unchanged");
      const before = readdirSync(repoBound);
      const outRoot = repoRootKind === "output" ? repoBound : external;
      const workRoot = repoRootKind === "work" ? repoBound : external;

      const result = spawnSync(
        "bash",
        [join(repoRoot, "packages/registry/rootfs/build-rootfs-package.sh")],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            WASM_POSIX_DEP_OUT_DIR: outRoot,
            WASM_POSIX_DEP_WORK_DIR: workRoot,
          },
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        `${errorLabel} must be outside the source checkout`,
      );
      expect(readdirSync(repoBound)).toEqual(before);
      expect(readFileSync(join(repoBound, "sentinel"), "utf8")).toBe(
        "unchanged",
      );
    },
  );

  it("uses only the explicitly selected artifact tree", () => {
    const scratch = makeScratch();
    const unique = `manifest-provenance-${process.pid}-${Date.now()}`;
    const lazyRel = `programs/wasm32/${unique}/lazy.wasm`;
    const eagerRel = `programs/wasm32/${unique}/eager.dat`;
    const localRoot = join(repoRoot, "local-binaries");
    scratchRoots.push(join(localRoot, "programs", "wasm32", unique));
    const selectedRoot = join(scratch, "selected-binaries");
    writeArtifact(localRoot, lazyRel, "local-override");
    writeArtifact(localRoot, eagerRel, "local-eager-override");
    writeArtifact(selectedRoot, lazyRel, "good");
    const selectedEager = writeArtifact(selectedRoot, eagerRel, "canonical");

    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        'lazy_url_prefix = "binaries/"',
        "",
        "[[packages]]",
        'name = "fixture"',
        "",
        "[[packages.outputs]]",
        `binary = "${lazyRel}"`,
        'path = "/usr/bin/fixture"',
        "",
        "[[packages.outputs]]",
        `binary = "${eagerRel}"`,
        'path = "/usr/share/fixture.dat"',
        'install = "eager"',
        'mode = "0644"',
        "",
      ].join("\n"),
    );

    const selectedOut = join(scratch, "selected.MANIFEST");
    const selected = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--out",
      selectedOut,
    ]);
    expect(selected.status, selected.stderr).toBe(0);
    const selectedManifest = readFileSync(selectedOut, "utf8");
    expect(selectedManifest).toContain(
      `lazy_url=binaries/${lazyRel} lazy_size=4`,
    );
    expect(selectedManifest).toContain(
      `src=${relative(repoRoot, selectedEager)}`,
    );
    expect(selectedManifest).not.toContain("local-binaries");

    const defaultOut = join(scratch, "default.MANIFEST");
    const defaultResult = runGenerator([
      "--packages",
      packages,
      "--out",
      defaultOut,
    ]);
    expect(defaultResult.status, defaultResult.stderr).toBe(0);
    const defaultManifest = readFileSync(defaultOut, "utf8");
    expect(defaultManifest).toContain("lazy_size=14");
    expect(defaultManifest).toContain(`src=local-binaries/${eagerRel}`);
  });

  it("makes only otherwise-unspecified package outputs eager", () => {
    const scratch = makeScratch();
    const selectedRoot = join(scratch, "selected-binaries");
    const implicitRel = "programs/wasm32/implicit.wasm";
    const outputLazyRel = "programs/wasm32/output-lazy.wasm";
    const outputEagerRel = "programs/wasm32/output-eager.wasm";
    const packageLazyRel = "programs/wasm32/package-lazy.wasm";
    const implicit = writeArtifact(selectedRoot, implicitRel, "implicit");
    writeArtifact(selectedRoot, outputLazyRel, "output-lazy");
    const outputEager = writeArtifact(
      selectedRoot,
      outputEagerRel,
      "output-eager",
    );
    writeArtifact(selectedRoot, packageLazyRel, "package-lazy");
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        'default_install = "lazy"',
        'lazy_url_prefix = "binaries/"',
        "[[packages]]",
        'name = "implicit-package"',
        "[[packages.outputs]]",
        `binary = "${implicitRel}"`,
        'path = "/usr/bin/implicit"',
        "[[packages.outputs]]",
        `binary = "${outputLazyRel}"`,
        'path = "/usr/bin/output-lazy"',
        'install = "lazy"',
        "[[packages.outputs]]",
        `binary = "${outputEagerRel}"`,
        'path = "/usr/bin/output-eager"',
        'install = "eager"',
        "[[packages]]",
        'name = "explicit-lazy-package"',
        'install = "lazy"',
        "[[packages.outputs]]",
        `binary = "${packageLazyRel}"`,
        'path = "/usr/bin/package-lazy"',
        "",
      ].join("\n"),
    );
    const out = join(scratch, "eager-default.MANIFEST");

    const result = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--default-install",
      "eager",
      "--out",
      out,
    ]);

    expect(result.status, result.stderr).toBe(0);
    const manifest = readFileSync(out, "utf8");
    expect(manifest).toContain(
      `/usr/bin/implicit f 0755 0 0 src=${relative(repoRoot, implicit)}`,
    );
    expect(manifest).toContain(
      `/usr/bin/output-lazy f 0755 0 0 lazy_url=binaries/${outputLazyRel} lazy_size=11`,
    );
    expect(manifest).toContain(
      `/usr/bin/output-eager f 0755 0 0 src=${relative(repoRoot, outputEager)}`,
    );
    expect(manifest).toContain(
      `/usr/bin/package-lazy f 0755 0 0 lazy_url=binaries/${packageLazyRel} lazy_size=12`,
    );
    expect(manifest).not.toContain(
      `/usr/bin/implicit f 0755 0 0 lazy_url=`,
    );
  });

  it("rejects an unsupported default install mode before writing output", () => {
    const scratch = makeScratch();
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(packages, "");
    const out = join(scratch, "invalid-default.MANIFEST");

    const result = runGenerator([
      "--packages",
      packages,
      "--default-install",
      "sometimes",
      "--out",
      out,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '--default-install must be either "lazy" or "eager"',
    );
    expect(() => readFileSync(out, "utf8")).toThrow();
  });

  it("keeps no-argument package builds canonical despite ambient release mode", () => {
    const { scratch, binaryRel, commonEnv } = makeRootfsBuildFixture();
    const canonicalManifest = join(scratch, "canonical.MANIFEST");
    const canonicalImage = join(scratch, "canonical.vfs");

    const canonical = spawnSync(
      "bash",
      [join(repoRoot, "scripts/build-rootfs.sh")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...commonEnv,
          ROOTFS_DEFAULT_INSTALL: "eager",
          ROOTFS_PACKAGE_MANIFEST: canonicalManifest,
          ROOTFS_OUT: canonicalImage,
        },
      },
    );

    expect(canonical.status, canonical.stderr).toBe(0);
    expect(readFileSync(canonicalManifest, "utf8")).toContain(
      `/usr/bin/fixture f 0755 0 0 lazy_url=binaries/${binaryRel} lazy_size=13`,
    );
    expect(
      MemoryFileSystem.fromImage(
        new Uint8Array(readFileSync(canonicalImage)),
      ).isPathDeferred("/usr/bin/fixture"),
    ).toBe(true);
  });

  it("makes only an explicit direct build eager despite ambient package mode", () => {
    const { scratch, binary, commonEnv } = makeRootfsBuildFixture();
    const eagerManifest = join(scratch, "eager.MANIFEST");
    const eagerImage = join(scratch, "eager.vfs");
    const eager = spawnSync(
      "bash",
      [
        join(repoRoot, "scripts/build-rootfs.sh"),
        "--default-install",
        "eager",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...commonEnv,
          ROOTFS_DEFAULT_INSTALL: "lazy",
          ROOTFS_PACKAGE_MANIFEST: eagerManifest,
          ROOTFS_OUT: eagerImage,
        },
      },
    );

    expect(eager.status, eager.stderr).toBe(0);
    expect(readFileSync(eagerManifest, "utf8")).toContain(
      `/usr/bin/fixture f 0755 0 0 src=${relative(repoRoot, binary)}`,
    );
    expect(
      MemoryFileSystem.fromImage(
        new Uint8Array(readFileSync(eagerImage)),
      ).isPathDeferred("/usr/bin/fixture"),
    ).toBe(false);
  });

  it("rejects an invalid build argument before package generation", () => {
    const result = spawnSync(
      "bash",
      [
        join(repoRoot, "scripts/build-rootfs.sh"),
        "--default-install",
        "sometimes",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          ROOTFS_SEALED_BUILD: "1",
          ROOTFS_SKIP_PACKAGE_RESOLVE: "1",
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'build-rootfs: --default-install must be either "lazy" or "eager"',
    );
    expect(result.stdout).not.toContain("Generating rootfs package manifest");
  });

  it("does not fall back to a local override when the selected tree is missing an output", () => {
    const scratch = makeScratch();
    const unique = `manifest-provenance-${process.pid}-${Date.now()}`;
    const binaryRel = `programs/wasm32/${unique}/fixture.wasm`;
    const localRoot = join(repoRoot, "local-binaries");
    scratchRoots.push(join(localRoot, "programs", "wasm32", unique));
    writeArtifact(localRoot, binaryRel, "override");
    const selectedRoot = join(scratch, "selected-binaries");
    mkdirSync(selectedRoot, { recursive: true });
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        `binary = "${binaryRel}"`,
        'path = "/usr/bin/fixture"',
        "",
      ].join("\n"),
    );

    const result = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--out",
      join(scratch, "missing.MANIFEST"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checked selected artifact tree");
    expect(result.stderr).not.toContain("local-binaries");
  });

  it.each([
    ["parent traversal", "../outside.wasm"],
    ["embedded parent traversal", "programs/wasm32/../outside.wasm"],
    ["dot component", "programs/./fixture.wasm"],
    ["empty component", "programs//fixture.wasm"],
    ["absolute path", "/programs/fixture.wasm"],
    ["drive path", "C:/programs/fixture.wasm"],
    ["backslash", "programs\\fixture.wasm"],
    ["NUL", "programs/fixture\0.wasm"],
    ["control character", "programs/fixture\x01.wasm"],
    ["non-NFC Unicode", "programs/cafe\u0301.wasm"],
  ])("rejects a noncanonical %s package output path", (_case, binaryRel) => {
    const scratch = makeScratch();
    const selectedRoot = join(scratch, "selected-binaries");
    mkdirSync(selectedRoot, { recursive: true });
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        `binary = "${binaryRel}"`,
        'path = "/usr/bin/fixture"',
        "",
      ].join("\n"),
    );

    const result = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--out",
      join(scratch, "noncanonical.MANIFEST"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "binary must be a canonical NFC relative POSIX path",
    );
  });

  it.each([
    ["percent-encoded parent", "programs/%2e%2e/fixture.wasm"],
    ["percent-encoded slash", "programs/%2f/fixture.wasm"],
    ["percent-encoded backslash", "programs/%5c/fixture.wasm"],
    ["query and fragment delimiters", "programs/fixture?query#fragment.wasm"],
    ["NFC Unicode", "programs/caf\u00e9.wasm"],
  ])(
    "URL-encodes a %s without changing artifact identity",
    (_case, binaryRel) => {
      const scratch = makeScratch();
      const selectedRoot = join(scratch, "selected-binaries");
      writeArtifact(selectedRoot, binaryRel, "good");
      const packages = join(scratch, "PACKAGES.toml");
      writeFileSync(
        packages,
        [
          'lazy_url_prefix = "binaries/"',
          "[[packages]]",
          'name = "fixture"',
          "[[packages.outputs]]",
          `binary = "${binaryRel}"`,
          'path = "/usr/bin/fixture"',
          "",
        ].join("\n"),
      );
      const out = join(scratch, "encoded.MANIFEST");

      const result = runGenerator([
        "--packages",
        packages,
        "--binaries-dir",
        relative(repoRoot, selectedRoot),
        "--out",
        out,
      ]);

      expect(result.status, result.stderr).toBe(0);
      const manifest = readFileSync(out, "utf8");
      const lazyUrl = /\blazy_url=(\S+)/.exec(manifest)?.[1];
      const encodedRel = binaryRel.split("/").map(encodeURIComponent).join("/");
      expect(lazyUrl).toBe(`binaries/${encodedRel}`);
      const resolvedUrl = new URL(lazyUrl!, "https://example.test/root/");
      expect(decodeURIComponent(resolvedUrl.pathname)).toBe(
        `/root/binaries/${binaryRel}`,
      );
    },
  );

  it("accepts a resolver symlink to a regular file", () => {
    const scratch = makeScratch();
    const selectedRoot = join(scratch, "selected-binaries");
    const binaryRel = "programs/wasm32/fixture.wasm";
    const target = writeArtifact(
      selectedRoot,
      "programs/wasm32/target.wasm",
      "target",
    );
    const link = join(selectedRoot, binaryRel);
    symlinkSync(target, link);
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        `binary = "${binaryRel}"`,
        'path = "/usr/bin/fixture"',
        "",
      ].join("\n"),
    );
    const out = join(scratch, "symlink.MANIFEST");

    const result = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--out",
      out,
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("lazy_size=6");
  });

  it.each(["directory", "broken symlink", "symlink cycle", "FIFO"])(
    "rejects a selected %s instead of emitting a lazy file",
    (kind) => {
      const scratch = makeScratch();
      const selectedRoot = join(scratch, "selected-binaries");
      const binaryRel = "programs/wasm32/fixture.wasm";
      const artifact = join(selectedRoot, binaryRel);
      mkdirSync(dirname(artifact), { recursive: true });
      if (kind === "broken symlink") {
        symlinkSync("missing.wasm", artifact);
      } else if (kind === "symlink cycle") {
        symlinkSync("loop.wasm", artifact);
        symlinkSync("fixture.wasm", join(dirname(artifact), "loop.wasm"));
      } else if (kind === "FIFO") {
        const mkfifo = spawnSync("mkfifo", [artifact], { encoding: "utf8" });
        expect(mkfifo.status, mkfifo.stderr).toBe(0);
      } else {
        mkdirSync(artifact);
      }
      const packages = join(scratch, "PACKAGES.toml");
      writeFileSync(
        packages,
        [
          "[[packages]]",
          'name = "fixture"',
          "[[packages.outputs]]",
          `binary = "${binaryRel}"`,
          'path = "/usr/bin/fixture"',
          "",
        ].join("\n"),
      );

      const result = runGenerator([
        "--packages",
        packages,
        "--binaries-dir",
        relative(repoRoot, selectedRoot),
        "--out",
        join(scratch, "invalid.MANIFEST"),
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("regular file");
    },
  );

  it("fails on an invalid local override instead of falling through to fetched bytes", () => {
    const scratch = makeScratch();
    const unique = `manifest-provenance-${process.pid}-${Date.now()}`;
    const binaryRel = `programs/wasm32/${unique}/fixture.wasm`;
    const localRoot = join(repoRoot, "local-binaries");
    const fetchedRoot = join(repoRoot, "binaries");
    scratchRoots.push(join(localRoot, "programs", "wasm32", unique));
    scratchRoots.push(join(fetchedRoot, "programs", "wasm32", unique));
    mkdirSync(join(localRoot, binaryRel), { recursive: true });
    writeArtifact(fetchedRoot, binaryRel, "fetched");
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        `binary = "${binaryRel}"`,
        'path = "/usr/bin/fixture"',
        "",
      ].join("\n"),
    );

    const result = runGenerator([
      "--packages",
      packages,
      "--out",
      join(scratch, "invalid-local.MANIFEST"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local override tree");
    expect(result.stderr).toContain("not a regular file");
  });
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
