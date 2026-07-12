import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPublicBottle } from "../../scripts/homebrew-verify-public-bottle";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("verifyPublicBottle", () => {
  it("writes bytes only after size and digest verification", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "verified", "bottle.tar.gz");
    const bottle = new TextEncoder().encode("verified bottle");

    await verifyPublicBottle({
      url: "https://ghcr.io/v2/example/tap/pkg/blobs/sha256:test",
      sha256: createHash("sha256").update(bottle).digest("hex"),
      bytes: bottle.byteLength,
      out,
    }, {
      fetchBottle: async () => bottle,
      sleep: async () => undefined,
    });

    expect(new Uint8Array(await readFile(out))).toEqual(bottle);
  });

  it("does not write bytes that fail verification", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "bottle.tar.gz");

    await expect(verifyPublicBottle({
      url: "https://ghcr.io/v2/example/tap/pkg/blobs/sha256:test",
      sha256: "0".repeat(64),
      bytes: 99,
      out,
    }, {
      fetchBottle: async () => new TextEncoder().encode("wrong"),
      sleep: async () => undefined,
    })).rejects.toThrow("byte count");
    expect(existsSync(out)).toBe(false);
  });

  it("does not retain a failed candidate across later network errors", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "bottle.tar.gz");
    let attempt = 0;

    await expect(verifyPublicBottle({
      url: "https://ghcr.io/v2/example/tap/pkg/blobs/sha256:test",
      sha256: "0".repeat(64),
      bytes: 99,
      out,
    }, {
      fetchBottle: async () => {
        attempt += 1;
        if (attempt === 1) return new TextEncoder().encode("wrong");
        throw new Error("network unavailable");
      },
      sleep: async () => undefined,
    })).rejects.toThrow("network unavailable");
    expect(attempt).toBe(3);
    expect(existsSync(out)).toBe(false);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kandelo-homebrew-public-bottle-"));
  temporaryDirectories.push(directory);
  return directory;
}
