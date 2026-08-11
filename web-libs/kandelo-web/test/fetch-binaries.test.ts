import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchKandeloIndex } from "../src/fetch-binaries";
import { ABI_VERSION } from "../../../host/src/generated/abi";

const INDEX_TOML = `abi_version = ${ABI_VERSION}\n`;

function fetchStub(): typeof fetch {
  return vi.fn(async () => {
    return new Response(new TextEncoder().encode(INDEX_TOML));
  }) as unknown as typeof fetch;
}

describe("fetchKandeloIndex baseUrl resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a relative baseUrl against the page URL", async () => {
    vi.stubGlobal("location", { href: "https://app.example/ide/" });
    const f = fetchStub();
    const index = await fetchKandeloIndex({ baseUrl: "/kandelo-binaries/", fetch: f });
    expect(index.baseUrl).toBe("https://app.example/kandelo-binaries/");
    expect(f).toHaveBeenCalledWith("https://app.example/kandelo-binaries/index.toml");
  });

  it("keeps an absolute baseUrl and appends the trailing slash", async () => {
    const index = await fetchKandeloIndex({
      baseUrl: "https://cdn.example/bins",
      fetch: fetchStub(),
    });
    expect(index.baseUrl).toBe("https://cdn.example/bins/");
  });
});
