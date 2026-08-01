import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_COMPRESSED_BOTTLE_BYTES,
  verifyPublicBottle,
} from "../../scripts/homebrew-verify-public-bottle";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
  })));
});

describe("verifyPublicBottle", () => {
  it("loads the compressed bottle policy from the shared publication limits", () => {
    expect(MAX_COMPRESSED_BOTTLE_BYTES).toBe(2 * 1024 * 1024 * 1024);
  });

  it("streams and accepts a response exactly at its byte limit", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "verified", "bottle.tar.gz");
    const chunks = [bytes("verified "), bytes("bottle")];
    const bottle = concat(chunks);

    await verifyPublicBottle({
      url: bottleUrl(sha256(bottle)),
      sha256: sha256(bottle),
      bytes: bottle.byteLength,
      out,
    }, {
      fetchResponse: async () => streamedResponse(chunks),
      maximumBytes: bottle.byteLength,
      sleep: async () => undefined,
    });

    expect(new Uint8Array(await readFile(out))).toEqual(bottle);
  });

  it("streams the authenticated body after an anonymous GHCR bearer challenge", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "bottle.tar.gz");
    const bottle = bytes("authenticated public bottle");
    const digest = sha256(bottle);
    const url = bottleUrl(digest);
    const calls: Array<{ url: string; authorization?: string }> = [];
    let unauthorizedBodyCancelled = false;

    vi.stubGlobal("fetch", async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const requestUrl = input.toString();
      const authorization = (init?.headers as Record<string, string> | undefined)
        ?.Authorization;
      calls.push({ url: requestUrl, authorization });
      if (requestUrl === url && !authorization) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes("unauthorized"));
          },
          cancel() {
            unauthorizedBodyCancelled = true;
          },
        }), {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:example/tap/pkg:pull"',
          },
        });
      }
      if (requestUrl.startsWith("https://ghcr.io/token?")) {
        return new Response(JSON.stringify({ token: "public-token" }));
      }
      if (requestUrl === url && authorization === "Bearer public-token") {
        return streamedResponse([bottle.subarray(0, 7), bottle.subarray(7)]);
      }
      throw new Error(`unexpected fetch ${requestUrl}`);
    });

    await verifyPublicBottle({
      url,
      sha256: digest,
      bytes: bottle.byteLength,
      out,
    }, {
      maximumBytes: bottle.byteLength,
      sleep: async () => undefined,
    });

    expect(unauthorizedBodyCancelled).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)?.authorization).toBe("Bearer public-token");
    expect(new Uint8Array(await readFile(out))).toEqual(bottle);
  });

  it("accepts the configured boundary before beginning network readback", async () => {
    const directory = await temporaryDirectory();
    let attempts = 0;

    await expect(verifyPublicBottle({
      url: bottleUrl("0".repeat(64)),
      sha256: "0".repeat(64),
      bytes: MAX_COMPRESSED_BOTTLE_BYTES,
      out: join(directory, "bottle.tar.gz"),
    }, {
      fetchResponse: async () => {
        attempts += 1;
        throw new Error("boundary network control");
      },
      sleep: async () => undefined,
    })).rejects.toThrow("boundary network control");
    expect(attempts).toBe(3);
  });

  it("rejects a declared bottle above the configured limit before fetching", async () => {
    const directory = await temporaryDirectory();
    let attempts = 0;

    await expect(verifyPublicBottle({
      url: bottleUrl("0".repeat(64)),
      sha256: "0".repeat(64),
      bytes: MAX_COMPRESSED_BOTTLE_BYTES + 1,
      out: join(directory, "bottle.tar.gz"),
    }, {
      fetchResponse: async () => {
        attempts += 1;
        return streamedResponse([]);
      },
      sleep: async () => undefined,
    })).rejects.toThrow("exceeds compressed bottle limit");
    expect(attempts).toBe(0);
  });

  it("stops an oversized response and removes every partial output", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "bottle.tar.gz");
    const bottle = bytes("12345");

    await expect(verifyPublicBottle({
      url: bottleUrl(sha256(bottle)),
      sha256: sha256(bottle),
      bytes: 4,
      out,
    }, {
      fetchResponse: async () => streamedResponse([
        bottle.subarray(0, 3),
        bottle.subarray(3),
      ]),
      maximumBytes: 4,
      sleep: async () => undefined,
    })).rejects.toThrow("exceeds compressed bottle limit 4 bytes");
    expect(existsSync(out)).toBe(false);
  });

  it("rejects a short response and removes every partial output", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "bottle.tar.gz");
    const bottle = bytes("short");

    await expect(verifyPublicBottle({
      url: bottleUrl(sha256(bottle)),
      sha256: sha256(bottle),
      bytes: bottle.byteLength + 1,
      out,
    }, {
      fetchResponse: async () => streamedResponse([bottle]),
      maximumBytes: bottle.byteLength + 1,
      sleep: async () => undefined,
    })).rejects.toThrow(
      `byte count ${bottle.byteLength} does not match expected ${bottle.byteLength + 1}`,
    );
    expect(existsSync(out)).toBe(false);
  });

  it("rejects a digest mismatch and removes every partial output", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "bottle.tar.gz");
    const bottle = bytes("wrong digest");

    await expect(verifyPublicBottle({
      url: bottleUrl("0".repeat(64)),
      sha256: "0".repeat(64),
      bytes: bottle.byteLength,
      out,
    }, {
      fetchResponse: async () => streamedResponse([bottle]),
      maximumBytes: bottle.byteLength,
      sleep: async () => undefined,
    })).rejects.toThrow("does not match expected");
    expect(existsSync(out)).toBe(false);
  });

  it("cleans a partial stream before retrying into the same exclusive path", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "bottle.tar.gz");
    const bottle = bytes("complete bottle");
    let attempts = 0;
    const sleeps: number[] = [];

    await verifyPublicBottle({
      url: bottleUrl(sha256(bottle)),
      sha256: sha256(bottle),
      bytes: bottle.byteLength,
      out,
    }, {
      fetchResponse: async () => {
        attempts += 1;
        if (attempts === 1) return failingResponse(bytes("partial"));
        return streamedResponse([bottle]);
      },
      maximumBytes: bottle.byteLength,
      sleep: async (milliseconds) => {
        expect(existsSync(out)).toBe(false);
        sleeps.push(milliseconds);
      },
    });

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([2_000]);
    expect(new Uint8Array(await readFile(out))).toEqual(bottle);
  });

  it("never replaces an output that already exists", async () => {
    const directory = await temporaryDirectory();
    const out = join(directory, "bottle.tar.gz");
    const existing = bytes("existing accepted bottle");
    const candidate = bytes("new candidate");
    let attempts = 0;
    await writeFile(out, existing);

    await expect(verifyPublicBottle({
      url: bottleUrl(sha256(candidate)),
      sha256: sha256(candidate),
      bytes: candidate.byteLength,
      out,
    }, {
      fetchResponse: async () => {
        attempts += 1;
        return streamedResponse([candidate]);
      },
      maximumBytes: candidate.byteLength,
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(attempts).toBe(0);
    expect(new Uint8Array(await readFile(out))).toEqual(existing);
  });
});

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bottleUrl(digest: string): string {
  return `https://ghcr.io/v2/example/tap/pkg/blobs/sha256:${digest}`;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function streamedResponse(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }));
}

function failingResponse(partial: Uint8Array): Response {
  let delivered = false;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(partial);
        return;
      }
      controller.error(new Error("connection reset after partial response"));
    },
  }));
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kandelo-homebrew-public-bottle-"));
  temporaryDirectories.push(directory);
  return directory;
}
