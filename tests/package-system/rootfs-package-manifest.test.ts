import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function runGenerator(args: string[]) {
  return spawnSync(process.execPath, [generator, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of scratchRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("generate-rootfs-package-manifest artifact provenance", () => {
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

  it("embeds every output of an explicitly eager package without duplicating its paths", () => {
    const scratch = makeScratch();
    const selectedRoot = join(scratch, "selected-binaries");
    const firstRel = "programs/wasm32/fixture/main.wasm";
    const secondRel = "programs/wasm32/fixture/helper.wasm";
    const first = writeArtifact(selectedRoot, firstRel, "main");
    const second = writeArtifact(selectedRoot, secondRel, "helper");
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        'default_install = "lazy"',
        'lazy_url_prefix = "binaries/"',
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        `binary = "${firstRel}"`,
        'path = "/usr/bin/fixture"',
        'aliases = ["/bin/fixture"]',
        "[[packages.outputs]]",
        `binary = "${secondRel}"`,
        'path = "/usr/bin/fixture-helper"',
        'install = "lazy"',
        "",
      ].join("\n"),
    );
    const out = join(scratch, "eager.MANIFEST");

    const result = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--eager-package",
      "fixture",
      "--out",
      out,
    ]);

    expect(result.status, result.stderr).toBe(0);
    const manifest = readFileSync(out, "utf8");
    expect(manifest).toContain(`/usr/bin/fixture f 0755 0 0 src=${relative(repoRoot, first)}`);
    expect(manifest).toContain(
      `/usr/bin/fixture-helper f 0755 0 0 src=${relative(repoRoot, second)}`,
    );
    expect(manifest).toContain("/bin/fixture l 0777 0 0 target=/usr/bin/fixture");
    expect(manifest).not.toContain("lazy_url=");
    expect(manifest.match(/^\/usr\/bin\/fixture /gm)).toHaveLength(1);

    const unknown = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--eager-package",
      "missing",
      "--out",
      join(scratch, "unknown.MANIFEST"),
    ]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("does not name a configured package: missing");
  });

  it("embeds only the selected output of a multi-output package", () => {
    const scratch = makeScratch();
    const selectedRoot = join(scratch, "selected-binaries");
    const mainRel = "programs/wasm32/fixture/main.wasm";
    const helperRel = "programs/wasm32/fixture/helper.wasm";
    writeArtifact(selectedRoot, mainRel, "main");
    const helper = writeArtifact(selectedRoot, helperRel, "helper");
    const packages = join(scratch, "PACKAGES.toml");
    writeFileSync(
      packages,
      [
        'default_install = "lazy"',
        'lazy_url_prefix = "binaries/"',
        "[[packages]]",
        'name = "fixture"',
        "[[packages.outputs]]",
        `binary = "${mainRel}"`,
        'path = "/usr/bin/fixture"',
        "[[packages.outputs]]",
        `binary = "${helperRel}"`,
        'path = "/usr/bin/fixture-helper"',
        'aliases = ["/bin/fixture-helper"]',
        "",
      ].join("\n"),
    );
    const out = join(scratch, "eager-output.MANIFEST");

    const result = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--eager-output",
      "fixture:/usr/bin/fixture-helper",
      "--out",
      out,
    ]);

    expect(result.status, result.stderr).toBe(0);
    const manifest = readFileSync(out, "utf8");
    expect(manifest).toContain(
      "/usr/bin/fixture f 0755 0 0 lazy_url=binaries/programs/wasm32/fixture/main.wasm",
    );
    expect(manifest).toContain(
      `/usr/bin/fixture-helper f 0755 0 0 src=${relative(repoRoot, helper)}`,
    );
    expect(manifest).toContain(
      "/bin/fixture-helper l 0777 0 0 target=/usr/bin/fixture-helper",
    );

    const unknown = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--eager-output",
      "fixture:/usr/bin/missing",
      "--out",
      join(scratch, "unknown-output.MANIFEST"),
    ]);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain(
      "does not name a configured output: fixture:/usr/bin/missing",
    );

    const duplicate = runGenerator([
      "--packages",
      packages,
      "--binaries-dir",
      relative(repoRoot, selectedRoot),
      "--eager-output",
      "fixture:/usr/bin/fixture-helper",
      "--eager-output",
      "fixture:/usr/bin/fixture-helper",
      "--out",
      join(scratch, "duplicate-output.MANIFEST"),
    ]);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain(
      "duplicate --eager-output: fixture:/usr/bin/fixture-helper",
    );
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
