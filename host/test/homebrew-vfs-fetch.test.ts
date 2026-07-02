import { describe, expect, it } from "vitest";
import {
  HomebrewBottleFetchError,
  fetchHomebrewBottleBytes,
} from "../src/homebrew-vfs-fetch";

function response(
  body: BodyInit | Record<string, unknown> = "",
  init: ResponseInit = {},
): Response {
  const payload = typeof body === "object" && !(body instanceof Uint8Array)
    ? JSON.stringify(body)
    : body;
  return new Response(payload as BodyInit, init);
}

describe("Homebrew bottle fetch", () => {
  it("retries registry blob fetches with the advertised bearer token", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = input.toString();
      calls.push({
        url,
        auth: init?.headers instanceof Headers
          ? init.headers.get("authorization") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.Authorization,
      });

      if (url === "https://ghcr.io/v2/org/tap/hello/blobs/sha256:abc" && !calls.at(-1)?.auth) {
        return response({ errors: [{ code: "UNAUTHORIZED" }] }, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:org/tap/hello:pull"',
          },
        });
      }
      if (url === "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aorg%2Ftap%2Fhello%3Apull") {
        return response({ token: "public-token" });
      }
      if (url === "https://ghcr.io/v2/org/tap/hello/blobs/sha256:abc") {
        expect(calls.at(-1)?.auth).toBe("Bearer public-token");
        return response(new Uint8Array([1, 2, 3]));
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    await expect(fetchHomebrewBottleBytes(
      "https://ghcr.io/v2/org/tap/hello/blobs/sha256:abc",
      { fetchImpl },
    )).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(calls.map((call) => call.url)).toEqual([
      "https://ghcr.io/v2/org/tap/hello/blobs/sha256:abc",
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aorg%2Ftap%2Fhello%3Apull",
      "https://ghcr.io/v2/org/tap/hello/blobs/sha256:abc",
    ]);
  });

  it("reports non-successful bottle fetches without hiding the HTTP status", async () => {
    const fetchImpl = async (): Promise<Response> => response("not found", { status: 404 });

    await expect(fetchHomebrewBottleBytes(
      "https://example.invalid/missing.bottle.tar.gz",
      { fetchImpl },
    )).rejects.toThrow(HomebrewBottleFetchError);
    await expect(fetchHomebrewBottleBytes(
      "https://example.invalid/missing.bottle.tar.gz",
      { fetchImpl },
    )).rejects.toThrow("HTTP 404");
  });
});
