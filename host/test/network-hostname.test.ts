import { describe, expect, it } from "vitest";
import {
  parseNumericIpv4Hostname,
  validateDnsHostname,
} from "../src/networking/hostname";

describe("network hostname parsing", () => {
  it.each([
    ["2130706433", [127, 0, 0, 1]],
    ["127.1", [127, 0, 0, 1]],
    ["127.1.1", [127, 1, 0, 1]],
    ["127.0.0.1", [127, 0, 0, 1]],
    ["010.010.010.010", [10, 10, 10, 10]],
    ["4294967295", [255, 255, 255, 255]],
    ["255.16777215", [255, 255, 255, 255]],
    ["255.255.65535", [255, 255, 255, 255]],
  ])("parses the decimal IPv4 form %s", (hostname, expected) => {
    expect(Array.from(parseNumericIpv4Hostname(hostname)!)).toEqual(expected);
  });

  it.each([
    "4294967296",
    "256.1",
    "1.16777216",
    "1.256.1",
    "1.2.65536",
    "1.2.3.256",
  ])("rejects the overflowing IPv4 form %s", (hostname) => {
    expect(() => parseNumericIpv4Hostname(hostname)).toThrow("ENOENT");
  });

  it.each([
    ".",
    ".1",
    "1.",
    "1..2",
    "1.2.3.4.5",
  ])("rejects the malformed numeric-looking name %s", (hostname) => {
    expect(() => parseNumericIpv4Hostname(hostname)).toThrow("ENOENT");
  });

  it("leaves ordinary DNS names for DNS validation", () => {
    expect(parseNumericIpv4Hostname("example.com")).toBeNull();
  });

  it("validates DNS wire lengths and preserves a trailing root dot", () => {
    const longestName = [63, 63, 63, 61]
      .map((length) => "a".repeat(length))
      .join(".");

    expect(() => validateDnsHostname("example.com")).not.toThrow();
    expect(() => validateDnsHostname("example.com.")).not.toThrow();
    expect(() => validateDnsHostname(longestName)).not.toThrow();
    expect(() => validateDnsHostname(`${longestName}.`)).not.toThrow();
  });

  it.each([
    `www.${"x".repeat(64)}.com`,
    [63, 63, 63, 62].map((length) => "x".repeat(length)).join("."),
    ".example.com",
    "example..com",
    "-example.com",
    "example-.com",
    "münich.example",
  ])("rejects the invalid DNS hostname %s", (hostname) => {
    expect(() => validateDnsHostname(hostname)).toThrow("ENOENT");
  });
});
