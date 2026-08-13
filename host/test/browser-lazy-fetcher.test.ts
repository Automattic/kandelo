import { describe, expect, it, vi } from "vitest";

import {
  corsProxyFetchUrl,
  corsProxyTargetUrl,
} from "../src/networking/cors-proxy-url";
import { createBrowserLazyFetcher } from "../src/vfs/browser-lazy-fetcher";

const RUNTIME_URL = "https://demo.kandelo.test/assets/kernel-worker.js";
const PROXY_CONFIG = {
  url: "https://demo.kandelo.test/__proxy?url=",
  allowedRequestHeaderNames: ["accept", "content-type", "accept"],
  allowAnonymousGetHeaderOmission: true,
} as const;

describe("browser lazy VFS fetch transport", () => {
  it("keeps same-origin lazy assets on the direct browser path", async () => {
    const fetchImpl = vi.fn(async () => new Response("same-origin"));
    const fetcher = createBrowserLazyFetcher(
      PROXY_CONFIG,
      { fetchImpl, runtimeUrl: RUNTIME_URL },
    );

    await fetcher("/assets/runtime.zip");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith("/assets/runtime.zip");
  });

  it("proxies external lazy assets without browser credentials", async () => {
    const fetchImpl = vi.fn(async () => new Response("external"));
    const controller = new AbortController();
    const target =
      "https://github.com/example/project/releases/download/v1/runtime.zip";
    const fetcher = createBrowserLazyFetcher(PROXY_CONFIG, {
      fetchImpl,
      runtimeUrl: RUNTIME_URL,
    });

    await fetcher(target, { signal: controller.signal });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${PROXY_CONFIG.url}${encodeURIComponent(target)}`,
      {
        signal: controller.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      },
    );
  });

  it("supports bare-query proxies and never proxies a proxy URL twice", async () => {
    const fetchImpl = vi.fn(async () => new Response("external"));
    const proxy = "https://proxy.kandelo.test/?";
    const target =
      "https://github.com/example/project/releases/download/v1/runtime.zip";
    const fetcher = createBrowserLazyFetcher({
      ...PROXY_CONFIG,
      url: proxy,
    }, {
      fetchImpl,
      runtimeUrl: RUNTIME_URL,
    });

    await fetcher(target);
    await fetcher(`${proxy}${target}`);

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      `${proxy}${target}`,
      `${proxy}${target}`,
    ]);
  });

  it("rejects an empty proxy before any lazy fetch starts", () => {
    expect(() =>
      createBrowserLazyFetcher({
        ...PROXY_CONFIG,
        url: "  ",
      }, { runtimeUrl: RUNTIME_URL })
    ).toThrow("browser lazy CORS proxy URL must not be empty");
  });

  it("recovers encoded and bare-query proxy targets for diagnostics", () => {
    const target =
      "https://github.com/example/project/releases/download/v1/runtime.zip";
    for (const proxy of [
      "https://demo.kandelo.test/__proxy?url=",
      "https://proxy.kandelo.test/?",
    ]) {
      expect(corsProxyTargetUrl(
        proxy,
        corsProxyFetchUrl(proxy, target),
      )).toBe(target);
    }
  });

  it("resolves a relative diagnostic proxy like the browser runtime", () => {
    const pageUrl = "https://demo.kandelo.test/kandelo/?demo=shell";
    const relativeProxy = "artifact-proxy?url=";
    const absoluteProxy = new URL(relativeProxy, pageUrl).href;
    const target =
      "https://github.com/example/project/releases/download/v1/runtime.zip";

    expect(corsProxyTargetUrl(
      relativeProxy,
      corsProxyFetchUrl(absoluteProxy, target),
      pageUrl,
    )).toBe(target);
  });

  it("does not decode unrelated, malformed, or non-HTTP proxy URLs", () => {
    const proxy = "https://demo.kandelo.test/__proxy?url=";
    expect(corsProxyTargetUrl(proxy, "https://elsewhere.test/file")).toBe(
      undefined,
    );
    expect(corsProxyTargetUrl(proxy, `${proxy}%zz`)).toBe(undefined);
    expect(corsProxyTargetUrl(
      "  ",
      "https://demo.kandelo.test/runtime.zip",
      RUNTIME_URL,
    )).toBe(undefined);
    expect(corsProxyTargetUrl(
      proxy,
      `${proxy}${encodeURIComponent("file:///tmp/private")}`,
    )).toBe(undefined);
  });
});
