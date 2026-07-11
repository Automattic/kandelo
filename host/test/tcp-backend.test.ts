import { describe, expect, it } from "vitest";
import { TcpNetworkBackend } from "../src/networking/tcp-backend";

describe("TcpNetworkBackend hostname parsing", () => {
  it.each([
    ["2130706433", [127, 0, 0, 1]],
    ["127.1", [127, 0, 0, 1]],
    ["127.1.1", [127, 1, 0, 1]],
    ["127.0.0.1", [127, 0, 0, 1]],
  ])("resolves the decimal IPv4 form %s without DNS", (hostname, expected) => {
    const backend = new TcpNetworkBackend();
    expect(Array.from(backend.getaddrinfo(hostname))).toEqual(expected);
  });

  it.each([
    "4294967296",
    "1..2",
    "1.2.3.256",
    ".example.com",
    "foo_bar.localhost",
    `www.${"x".repeat(64)}.com`,
  ])("rejects the invalid hostname %s before DNS", (hostname) => {
    const backend = new TcpNetworkBackend();
    expect(() => backend.getaddrinfo(hostname)).toThrow("ENOENT");
  });
});
