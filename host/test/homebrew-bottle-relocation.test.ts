import { describe, expect, it } from "vitest";
import {
  deriveHomebrewBottleGuestPrefix,
  parseHomebrewInstallReceiptRelocation,
  relocateHomebrewBottleFile,
} from "../src/homebrew-bottle-relocation";

const REV22_DASH_RECEIPT = `{
  "homebrew_version": ">=4.3.0 (shallow or no git repository)",
  "used_options": [],
  "unused_options": [],
  "built_as_bottle": true,
  "poured_from_bottle": false,
  "loaded_from_api": false,
  "loaded_from_internal_api": false,
  "installed_on_request": true,
  "changed_files": [
    "INSTALL_RECEIPT.json"
  ],
  "time": null,
  "source_modified_time": 1670740879,
  "compiler": "gcc-13",
  "aliases": [],
  "runtime_dependencies": [],
  "source": {
    "tap": "kandelo-dev/tap-core",
    "spec": "stable",
    "path": "@@HOMEBREW_LIBRARY@@/Taps/kandelo-dev/homebrew-tap-core/Formula/dash.rb",
    "versions": {
      "stable": "0.5.12",
      "head": null,
      "version_scheme": 0,
      "compatibility_version": null
    }
  },
  "arch": "x86_64",
  "built_on": {
    "os": "Linux",
    "os_version": "Ubuntu 24.04.4 LTS",
    "cpu_family": "zen3",
    "glibc_version": "2.39",
    "oldest_cpu_family": "core2"
  }
}`;

describe("Homebrew bottle receipt relocation", () => {
  it.each([
    {
      label: "immutable rev22",
      prefix: "/home/linuxbrew/.linuxbrew",
      relocatedBytes: 943,
    },
    {
      label: "current Kandelo",
      prefix: "/opt/kandelo/homebrew",
      relocatedBytes: 938,
    },
  ])("relocates the exact $label Dash receipt for its guest prefix", ({
    prefix,
    relocatedBytes,
  }) => {
    const source = new TextEncoder().encode(REV22_DASH_RECEIPT);
    expect(source.byteLength).toBe(929);
    const receipt = parseHomebrewInstallReceiptRelocation(source);
    const relocated = relocateHomebrewBottleFile(source, receipt, {
      guestPrefix: prefix,
      path: `${prefix}/Cellar/dash/0.5.12/INSTALL_RECEIPT.json`,
    });

    expect(relocated.byteLength).toBe(relocatedBytes);
    expect(JSON.parse(new TextDecoder().decode(relocated))).toMatchObject({
      source: {
        path:
          `${prefix}/Library/Taps/kandelo-dev/` +
          "homebrew-tap-core/Formula/dash.rb",
      },
    });
  });

  it.each([
    "/home/linuxbrew/.linuxbrew",
    "/opt/kandelo/homebrew",
  ])("derives %s from the authenticated receipt destination", (prefix) => {
    expect(deriveHomebrewBottleGuestPrefix(
      `${prefix}/Cellar/dash/0.5.12/INSTALL_RECEIPT.json`,
      "dash/0.5.12/INSTALL_RECEIPT.json",
    )).toBe(prefix);
  });

  it("rejects a receipt destination outside its declared Cellar source", () => {
    expect(() => deriveHomebrewBottleGuestPrefix(
      "/opt/kandelo/homebrew/Library/INSTALL_RECEIPT.json",
      "dash/0.5.12/INSTALL_RECEIPT.json",
    )).toThrow(/does not match its source path/);
  });
});
