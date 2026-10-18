import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("ffmpeg fixtures", () => {
  it("every committed fixture matches its recorded sha256", () => {
    const manifest = JSON.parse(
      readFileSync(join(fixtures, "manifest.json"), "utf8"),
    ) as Record<string, string>;
    const onDisk = readdirSync(fixtures)
      .filter((f) => f !== "manifest.json" && f !== "README.md")
      .sort();
    expect(Object.keys(manifest).sort()).toEqual(onDisk);
    for (const [name, sha] of Object.entries(manifest)) {
      const actual = createHash("sha256")
        .update(readFileSync(join(fixtures, name)))
        .digest("hex");
      expect(actual, name).toBe(sha);
    }
  });

  it("keeps the committed clip small", () => {
    expect(readFileSync(join(fixtures, "fixture.mp4")).byteLength)
      .toBeLessThan(100 * 1024);
  });
});
