import { describe, expect, it } from "vitest";
import { isWebKitLikeUserAgent } from "../../apps/browser-demos/lib/browser-engine";

describe("browser engine detection", () => {
  it("selects Safari and WebKit without selecting compatibility tokens", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      + "AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15";
    const alternatives = [
      "AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
      "AppleWebKit/605.1.15 CriOS/126.0 Mobile/15E148 Safari/604.1",
      "AppleWebKit/537.36 Chromium/126.0 Safari/537.36",
      "AppleWebKit/537.36 Chrome/126.0 Safari/537.36 Edg/126.0",
      "AppleWebKit/537.36 Chrome/126.0 Safari/537.36 OPR/112.0",
      "Gecko/20100101 Firefox/128.0",
      "AppleWebKit/605.1.15 FxiOS/128.0 Mobile/15E148 Safari/605.1.15",
    ];

    expect(isWebKitLikeUserAgent(safari)).toBe(true);
    for (const userAgent of alternatives) {
      expect(isWebKitLikeUserAgent(userAgent)).toBe(false);
    }
  });
});
