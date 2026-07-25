import { spawnSync } from "node:child_process";
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

afterEach(() => {
  for (const root of scratchRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("generate-rootfs-package-manifest artifact provenance", () => {
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
