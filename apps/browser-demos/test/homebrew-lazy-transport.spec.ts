import { expect, test } from "@playwright/test";
import {
  browserResolvedLazySourceUrl,
  expectedBrowserLazyTransport,
} from "./support/homebrew-lazy-transport";

test("classifies browser lazy transport after URL normalization", () => {
  const pageUrl = "https://demo.kandelo.test/kandelo/?demo=shell";
  const sameOrigin = browserResolvedLazySourceUrl(
    "/assets/root.zip",
    pageUrl,
  );
  const external = browserResolvedLazySourceUrl(
    "https://packages.example/runtime.zip",
    pageUrl,
  );
  expect(sameOrigin).toBe("https://demo.kandelo.test/assets/root.zip");
  expect(expectedBrowserLazyTransport(sameOrigin, pageUrl)).toBe("direct");
  expect(external).toBe("https://packages.example/runtime.zip");
  expect(expectedBrowserLazyTransport(external, pageUrl)).toBe("proxy");
  expect(() =>
    browserResolvedLazySourceUrl("assets/ambiguous.zip", pageUrl)
  ).toThrow(
    "lazy source must be absolute or root-relative",
  );
});
