import { describe, expect, it } from "vitest";

import {
  parseHomebrewInstallReceiptRelocation,
  relocateHomebrewBottleFile,
} from "../src/homebrew-bottle-relocation";

const AMBIENT_PREFIX = "/opt/kandelo/homebrew";

describe("Homebrew bottle receipt relocation", () => {
  it.each([
    "/home/linuxbrew/.linuxbrew",
    "/opt/kandelo/homebrew",
  ])("uses the authenticated destination %s instead of an ambient Homebrew default", (destinationPrefix) => {
    const source = new TextEncoder().encode([
      "prefix=@@HOMEBREW_PREFIX@@",
      "library=@@HOMEBREW_LIBRARY@@",
      "java=@@HOMEBREW_JAVA@@",
    ].join("\n"));
    const receipt = parseHomebrewInstallReceiptRelocation(new TextEncoder().encode(JSON.stringify({
      changed_files: ["lib/runtime.conf"],
      runtime_dependencies: [{ full_name: "openjdk@21" }],
    })));
    expect(new TextDecoder().decode(relocateHomebrewBottleFile(source, receipt, {
      destinationPrefix,
      path: `${destinationPrefix}/Cellar/runtime/1.0/lib/runtime.conf`,
    }))).toBe([
      `prefix=${destinationPrefix}`,
      `library=${destinationPrefix}/Library`,
      `java=${destinationPrefix}/opt/openjdk@21/libexec`,
    ].join("\n"));
  });

  it.each([
    "",
    "relative/homebrew",
    "/opt/../homebrew",
    "/opt/./homebrew",
    "/opt/kandelo\0homebrew",
  ])("rejects an unsafe authenticated destination prefix %j", (destinationPrefix) => {
    const receipt = parseHomebrewInstallReceiptRelocation(new TextEncoder().encode("{}"));
    expect(() => relocateHomebrewBottleFile(new Uint8Array(), receipt, {
      destinationPrefix,
      path: "/untrusted/receipt",
    })).toThrow(/destination prefix|guest prefix|unsafe path/i);
  });

  it("does not silently substitute the ambient prefix for an authenticated destination", () => {
    const receipt = parseHomebrewInstallReceiptRelocation(new TextEncoder().encode(JSON.stringify({
      changed_files: ["lib/runtime.conf"],
    })));
    const relocated = new TextDecoder().decode(relocateHomebrewBottleFile(
      new TextEncoder().encode("@@HOMEBREW_PREFIX@@\n"),
      receipt,
      {
        destinationPrefix: "/home/linuxbrew/.linuxbrew",
        path: "/home/linuxbrew/.linuxbrew/Cellar/runtime/1.0/lib/runtime.conf",
      },
    ));

    expect(relocated).not.toContain(AMBIENT_PREFIX);
    expect(relocated).toBe("/home/linuxbrew/.linuxbrew\n");
  });
});
