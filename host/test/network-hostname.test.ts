import { describe, expect, it } from "vitest";
import { validateSyntheticDnsHostname } from "../src/networking/hostname";

// The `inet_aton(3)` grammar and the DNS host-name syntax check that used to
// live beside this policy are now the kernel's, in
// `crates/runtime-core/src/hostname.rs`, and are covered by that module's own
// tests. What is left here is the one rule a synthetic-address backend owns.
describe("synthetic DNS hostname policy", () => {
  it.each(["invalid", "example.invalid", "EXAMPLE.INVALID", "a.b.invalid."])(
    "refuses %s, which RFC 6761 guarantees cannot resolve",
    (hostname) => {
      expect(() => validateSyntheticDnsHostname(hostname)).toThrow("ENOENT");
    },
  );

  it("lets a configured host alias override the rule, as /etc/hosts would", () => {
    const aliases = { "registry.invalid": "registry.npmjs.org" };
    expect(() => validateSyntheticDnsHostname("registry.invalid", aliases)).not.toThrow();
    expect(() => validateSyntheticDnsHostname("REGISTRY.INVALID", aliases)).not.toThrow();
    expect(() => validateSyntheticDnsHostname("other.invalid", aliases)).toThrow("ENOENT");
  });

  it("passes through the names a resolver is allowed to answer", () => {
    expect(() => validateSyntheticDnsHostname("example.com")).not.toThrow();
    expect(() => validateSyntheticDnsHostname("example.com.")).not.toThrow();
    expect(() => validateSyntheticDnsHostname("invalidate.example")).not.toThrow();
  });
});
