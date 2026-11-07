import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeSourceRootfsDemoConfig } from "../../images/vfs/scripts/build-source-rootfs-shell-image";
import {
  CANONICAL_SHELL_SELECTION,
  filterDemoConfigForSelection,
  partialShellSelection,
  readShellContractPackageNames,
  requireProfileRequirementsDeclared,
  selectionIncludes,
} from "../../images/vfs/scripts/shell-selection";
import { parseKandeloDemoConfig, type KandeloDemoConfig } from "../../web-libs/kandelo-session/src/demo-config";

const shellDir = new URL("../../packages/registry/shell/", import.meta.url);
const basePath = new URL("source-rootfs-shell-demo.json", shellDir).pathname;
const overlayPath = new URL("source-rootfs-shell-demo-profiles.json", shellDir).pathname;

function trackedShellConfig(): KandeloDemoConfig {
  const config = parseKandeloDemoConfig(
    new TextDecoder().decode(composeSourceRootfsDemoConfig(basePath, overlayPath)),
  );
  if (config === null) throw new Error("unparseable composed demo config");
  return config;
}

const BASE = ["rootfs", "bash", "coreutils", "ncurses", "ca-certificates"];

describe("shell selection", () => {
  it("includes everything canonically and only named packages partially", () => {
    expect(selectionIncludes(CANONICAL_SHELL_SELECTION, "ffmpeg")).toBe(true);
    const partial = partialShellSelection([...BASE, "fbdoom"]);
    expect(selectionIncludes(partial, "fbdoom")).toBe(true);
    expect(selectionIncludes(partial, "ffmpeg")).toBe(false);
  });

  it("keeps every profile for the canonical selection", () => {
    const config = trackedShellConfig();
    const result = filterDemoConfigForSelection(config, CANONICAL_SHELL_SELECTION);
    expect(result.config).toEqual(config);
    expect(result.excluded).toEqual([]);
    expect(result.included.sort()).toEqual(Object.keys(config.profiles ?? {}).sort());
  });

  it("keeps only the base shell profile for the base selection", () => {
    const result = filterDemoConfigForSelection(trackedShellConfig(), partialShellSelection(BASE));
    expect(result.included).toEqual(["shell"]);
    expect(Object.keys(result.config.profiles ?? {})).toEqual(["shell"]);
    expect(result.config.defaultProfile).toBe("shell");
    expect(result.excluded).toContainEqual({ profile: "doom", missing: ["fbdoom"] });
  });

  it("keeps a profile once its packages are selected", () => {
    const result = filterDemoConfigForSelection(
      trackedShellConfig(),
      partialShellSelection([...BASE, "fbdoom"]),
    );
    expect(result.included.sort()).toEqual(["doom", "shell"]);
  });

  it("names the runtime helpers a named package's activity still needs", () => {
    const result = filterDemoConfigForSelection(
      trackedShellConfig(),
      partialShellSelection([...BASE, "scummvm"]),
    );
    expect(result.included).not.toContain("scummvm");
    expect(result.excluded).toContainEqual({ profile: "scummvm", missing: ["curl", "unzip"] });
  });

  it("requires every declared requirement to be a shell package", () => {
    const names = readShellContractPackageNames();
    expect(() => requireProfileRequirementsDeclared(trackedShellConfig(), names)).not.toThrow();
    const config = trackedShellConfig();
    config.profiles!.doom.requires = ["not-a-shell-package"];
    expect(() => requireProfileRequirementsDeclared(config, names))
      .toThrow(/doom requires not-a-shell-package, which is not a shell package/);
  });

  it("reads the shell contract's package names", () => {
    const names = readShellContractPackageNames();
    const contract = JSON.parse(readFileSync(new URL("source-rootfs-shell-dependencies.json", shellDir), "utf8"));
    expect([...names].sort()).toEqual(contract.dependencies.map((d: { name: string }) => d.name).sort());
  });
});
