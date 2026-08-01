import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KANDELO_HOMEBREW_GUEST_LAYOUT } from
  "../src/homebrew-guest-layout";

interface GuestLayoutContract {
  schema: number;
  kind: string;
  prefix: string;
  cellar: string;
  repository: string;
  stable_entrypoint: string;
  retired_prefixes: string[];
}

const contract = JSON.parse(
  readFileSync(
    resolve("../homebrew/kandelo-guest-layout.json"),
    "utf8",
  ),
) as GuestLayoutContract;

describe("Kandelo guest Homebrew layout", () => {
  it("keeps the runtime projection synchronized with the distribution contract", () => {
    expect(contract).toEqual({
      schema: 1,
      kind: "kandelo-homebrew-guest-layout",
      prefix: "/opt/kandelo/homebrew",
      cellar: "/opt/kandelo/homebrew/Cellar",
      repository: "/opt/kandelo/homebrew",
      stable_entrypoint: "/usr/bin/brew",
      retired_prefixes: ["/home/linuxbrew/.linuxbrew"],
    });
    expect(KANDELO_HOMEBREW_GUEST_LAYOUT).toEqual({
      prefix: contract.prefix,
      cellar: contract.cellar,
      repository: contract.repository,
      stableEntrypoint: contract.stable_entrypoint,
    });
  });

  it("uses a Kandelo-owned system prefix rather than a host OS identity", () => {
    expect(contract.cellar).toBe(`${contract.prefix}/Cellar`);
    expect(contract.repository).toBe(contract.prefix);
    expect(contract.prefix).toMatch(/^\/opt\/kandelo\//);
    expect(contract.prefix.toLowerCase()).not.toContain("linux");
    expect(contract.retired_prefixes).not.toContain(contract.prefix);
  });
});
