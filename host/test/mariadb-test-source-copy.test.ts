import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyMariaDbTestSources,
} from "../../images/vfs/scripts/mariadb-test-source-copy";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

// The fixture is the producer that ships. `copyMariaDbTestSources` writes into
// whatever image filesystem a builder hands it, and every builder hands it a
// `KandeloImageFs`; the suite was proving the copier against a filesystem no
// builder uses.
function createFs(): KandeloImageFs {
  return KandeloImageFs.create();
}

function readVfsText(fs: KandeloImageFs, path: string): string {
  return new TextDecoder().decode(fs.readFile(path));
}

function withMariaDbSource(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "mariadb-test-source-"));
  try {
    mkdirSync(join(root, "main"));
    mkdirSync(join(root, "include"));
    mkdirSync(join(root, "std_data"));
    writeFileSync(join(root, "main", "selected.test"), "selected");
    writeFileSync(join(root, "main", "other.test"), "other");
    writeFileSync(join(root, "main", "README"), "not a test");
    writeFileSync(join(root, "include", "helper.inc"), "include");
    writeFileSync(join(root, "std_data", "fixture.dat"), "fixture");
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("MariaDB test source closure", () => {
  it("keeps the artifact and browser runner on one curated selection", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    const builder = readFileSync(
      join(repoRoot, "images/vfs/scripts/build-mariadb-test-vfs-image.ts"),
      "utf8",
    );
    const runner = readFileSync(
      join(repoRoot, "scripts/run-browser-mariadb-tests.sh"),
      "utf8",
    );
    const builderBody = builder.match(
      /const CURATED_TESTS = \[([\s\S]*?)\];/,
    )?.[1];
    const runnerBody = runner.match(
      /CURATED_TESTS=\(([\s\S]*?)\n\)/,
    )?.[1];
    expect(builderBody, "builder curated test list").toBeDefined();
    expect(runnerBody, "runner curated test list").toBeDefined();

    const builderTests = Array.from(
      builderBody!.matchAll(/"([^"]+)"/g),
      (match) => match[1],
    );
    const runnerTests = runnerBody!.trim().split(/\s+/);
    expect(builderTests).toEqual(runnerTests);
    expect(new Set(builderTests).size).toBe(builderTests.length);
  });

  it("copies every curated test and both required fixture trees", () => {
    withMariaDbSource((root) => {
      const fs = createFs();

      expect(copyMariaDbTestSources(fs, root, {
        includeAll: false,
        curatedTests: ["selected"],
      })).toBe(1);

      expect(readVfsText(fs, "/mysql-test/main/selected.test")).toBe("selected");
      expect(() => fs.stat("/mysql-test/main/other.test")).toThrow();
      expect(readVfsText(fs, "/mysql-test/include/helper.inc")).toBe("include");
      expect(readVfsText(fs, "/mysql-test/std_data/fixture.dat")).toBe("fixture");
    });
  });

  it("copies every .test entry in all-tests mode and ignores unrelated files", () => {
    withMariaDbSource((root) => {
      const fs = createFs();

      expect(copyMariaDbTestSources(fs, root, {
        includeAll: true,
        curatedTests: [],
      })).toBe(2);

      expect(readVfsText(fs, "/mysql-test/main/selected.test")).toBe("selected");
      expect(readVfsText(fs, "/mysql-test/main/other.test")).toBe("other");
      expect(() => fs.stat("/mysql-test/main/README")).toThrow();
    });
  });

  it("rejects a missing declared curated test", () => {
    withMariaDbSource((root) => {
      unlinkSync(join(root, "main", "selected.test"));

      expect(() => copyMariaDbTestSources(createFs(), root, {
        includeAll: false,
        curatedTests: ["selected"],
      })).toThrow(/selected\.test/);
    });
  });

  it("rejects a non-regular .test source", () => {
    withMariaDbSource((root) => {
      unlinkSync(join(root, "main", "selected.test"));
      mkdirSync(join(root, "main", "selected.test"));

      expect(() => copyMariaDbTestSources(createFs(), root, {
        includeAll: false,
        curatedTests: ["selected"],
      })).toThrow(/MariaDB test source entry is not a regular file/);
    });
  });

  it.each(["include", "std_data"] as const)(
    "rejects a missing required %s fixture tree",
    (fixtureName) => {
      withMariaDbSource((root) => {
        rmSync(join(root, fixtureName), { recursive: true });

        expect(() => copyMariaDbTestSources(createFs(), root, {
          includeAll: false,
          curatedTests: ["selected"],
        })).toThrow();
      });
    },
  );

  it.each(["include", "std_data"] as const)(
    "rejects an empty required %s fixture tree",
    (fixtureName) => {
      withMariaDbSource((root) => {
        rmSync(join(root, fixtureName), { recursive: true });
        mkdirSync(join(root, fixtureName));

        expect(() => copyMariaDbTestSources(createFs(), root, {
          includeAll: false,
          curatedTests: ["selected"],
        })).toThrow(/Required MariaDB test fixture tree is empty/);
      });
    },
  );
});
