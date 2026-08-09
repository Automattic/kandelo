import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertStagedProductEnvironment,
  createRepositoryPathBundle,
  materializeRepositoryPathBundle,
  parseStagedProductInvocation,
  readRepositoryPathBundle,
} from "../../images/vfs/scripts/staged-product-inputs";

const cleanupDirectories = new Set<string>();
const SOURCE = {
  repository: "kandelo-dev/kandelo",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
};

afterEach(() => {
  for (const directory of cleanupDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

describe("staged VFS product inputs", () => {
  it("recognizes only the exact opt-in flag triple", () => {
    expect(parseStagedProductInvocation([])).toBeNull();
    expect(
      parseStagedProductInvocation([
        "--vfs-product-manifest",
        "/tmp/product.toml",
        "--vfs-product-inputs",
        "/tmp/inputs.json",
        "--vfs-product-report",
        "/tmp/report.json",
        "--vfs-product-output",
        "/tmp/product.vfs",
      ]),
    ).toEqual({
      manifestPath: "/tmp/product.toml",
      resolvedInputsPath: "/tmp/inputs.json",
      builderReportPath: "/tmp/report.json",
      outputPath: "/tmp/product.vfs",
    });

    for (const arguments_ of [
      ["--vfs-product-inputs", "/tmp/inputs.json"],
      [
        "--vfs-product-manifest",
        "/tmp/product.toml",
        "--vfs-product-inputs",
        "/tmp/inputs.json",
        "--vfs-product-report",
        "/tmp/report.json",
        "--vfs-product-output",
        "/tmp/product.vfs",
        "legacy",
      ],
      [
        "--vfs-product-manifest",
        "/tmp/product.toml",
        "--vfs-product-inputs",
        "/tmp/inputs.json",
        "--vfs-product-inputs",
        "/tmp/other.json",
        "--vfs-product-report",
        "/tmp/report.json",
      ],
      [
        "--vfs-product-manifest",
        "/tmp/product.toml",
        "--vfs-product-inputs",
        "relative.json",
        "--vfs-product-report",
        "/tmp/report.json",
        "--vfs-product-output",
        "/tmp/product.vfs",
      ],
    ]) {
      expect(() => parseStagedProductInvocation(arguments_)).toThrow(
        /staging flags|absolute|unknown|duplicate/,
      );
    }
  });

  it("rejects ambient package, resolver, and builder input authority", () => {
    expect(() =>
      assertStagedProductEnvironment({
        PATH: "/declared/tools",
        SOURCE_DATE_EPOCH: "0",
      }),
    ).not.toThrow();

    for (const name of [
      "BOTTLE_CACHE",
      "KANDELO_NO_OPCACHE_PREWARM",
      "KANDELO_OPCACHE_PREWARM_STRICT",
      "KANDELO_VFS_INPUT_ROOT",
      "ROOTFS_BINARIES_DIR",
      "WASM_POSIX_BINARY_CACHE_ROOT",
      "WASM_POSIX_DEPS_REGISTRY",
      "WASM_POSIX_DEP_DASH_DIR",
    ]) {
      expect(() =>
        assertStagedProductEnvironment({
          PATH: "/declared/tools",
          [name]: "/ambient/input",
        }),
      ).toThrow(new RegExp(name));
    }
  });

  it("packs and restores only a canonical exact-source path bundle", () => {
    const root = fixtureDirectory("kandelo-staged-repository-");
    const source = join(root, "source");
    const output = join(root, "bundle.json");
    const restored = join(root, "restored");
    mkdirSync(join(source, "tree"), { recursive: true });
    writeFileSync(join(source, "one.txt"), "one\n");
    writeFileSync(join(source, "tree/two.sh"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(source, "tree/empty"), "");
    chmodSync(join(source, "tree/two.sh"), 0o755);
    symlinkSync("../one.txt", join(source, "tree/one-link"));
    writeFileSync(join(source, "unselected.txt"), "must not be packed\n");

    createRepositoryPathBundle({
      repositoryRoot: source,
      paths: ["one.txt", "tree"],
      source: SOURCE,
      outputPath: output,
    });

    const text = readFileSync(output, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("unselected.txt");
    const bundle = readRepositoryPathBundle(output, SOURCE);
    expect(bundle.paths).toEqual(["one.txt", "tree"]);
    expect(bundle.entries.map((entry) => entry.path)).toEqual([
      "one.txt",
      "tree",
      "tree/empty",
      "tree/one-link",
      "tree/two.sh",
    ]);

    materializeRepositoryPathBundle(bundle, restored);
    expect(readFileSync(join(restored, "one.txt"), "utf8")).toBe("one\n");
    expect(readFileSync(join(restored, "tree/two.sh"), "utf8")).toBe(
      "#!/bin/sh\nexit 0\n",
    );
    expect(readFileSync(join(restored, "tree/empty"), "utf8")).toBe("");
    expect(lstatSync(join(restored, "tree/two.sh")).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(restored, "tree/one-link")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(restored, "tree/one-link"))).toBe("../one.txt");
  });

  it("rejects omitted roots, tampered contents, path escapes, and source drift", () => {
    const root = fixtureDirectory("kandelo-staged-repository-invalid-");
    const source = join(root, "source");
    const output = join(root, "bundle.json");
    mkdirSync(source);
    writeFileSync(join(source, "one.txt"), "one\n");

    expect(() =>
      createRepositoryPathBundle({
        repositoryRoot: source,
        paths: ["missing"],
        source: SOURCE,
        outputPath: output,
      }),
    ).toThrow(/missing/);

    createRepositoryPathBundle({
      repositoryRoot: source,
      paths: ["one.txt"],
      source: SOURCE,
      outputPath: output,
    });
    const parsed = JSON.parse(readFileSync(output, "utf8"));
    parsed.entries[0].content_base64 = Buffer.from("other\n").toString("base64");
    writeFileSync(output, `${JSON.stringify(sortJson(parsed))}\n`);
    expect(() => readRepositoryPathBundle(output, SOURCE)).toThrow(
      /byte count|SHA-256/,
    );

    parsed.entries[0] = {
      ...parsed.entries[0],
      bytes: 6,
      path: "../escape",
      sha256: sha256("other\n"),
    };
    writeFileSync(output, `${JSON.stringify(sortJson(parsed))}\n`);
    expect(() => readRepositoryPathBundle(output, SOURCE)).toThrow(/path/);

    parsed.entries[0].path = "one.txt";
    writeFileSync(output, `${JSON.stringify(sortJson(parsed))}\n`);
    expect(() =>
      readRepositoryPathBundle(output, { ...SOURCE, tree: "c".repeat(40) }),
    ).toThrow(/source/);
  });
});

function fixtureDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirectories.add(directory);
  return directory;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
