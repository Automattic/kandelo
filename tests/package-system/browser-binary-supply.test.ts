import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserBinaryDemands,
  classifyUnsupplied,
  supportedPackageNames,
  unpublishedBinaryDemands,
  unsuppliedBinaryDemands,
  virtualModuleDemands,
} from "../../scripts/check-browser-binary-supply";
import { readLocalSupportedSet } from "../../scripts/local-supported-set.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * `./run.sh setup` and `./run.sh local-build` build exactly the packages in
 * packages/sets/local-supported.toml. Every binary the browser app imports, or
 * a VFS image records as a lazy entry, must therefore be an output of one of
 * them. Otherwise it surfaces later as a skipped spec or a runtime 404.
 */
describe("browser binary supply", () => {
  it("every browser import and image lazy entry is produced by a supported package", () => {
    expect(unsuppliedBinaryDemands(repoRoot)).toEqual([]);
  });

  it("collects demands from both the browser imports and the image metadata", () => {
    const demands = new Map(
      browserBinaryDemands(repoRoot).map((demand) => [demand.binary, demand.consumers]),
    );
    expect(demands.get("programs/wasm32/termchat.wasm")).toEqual([
      "SHELL_LAZY_BINARY_SPECS termchat",
      "browser @binaries import",
    ]);
    expect(demands.get("programs/wasm32/bash.wasm")).toContain(
      "images/rootfs/PACKAGES.toml package bash",
    );
    // A local conformance fixture, not a package output.
    expect(demands.has("programs/wasm32/fbtest.wasm")).toBe(false);
  });

  it("reads the supported set's packages less its exclusions", () => {
    const supported = supportedPackageNames(repoRoot);
    expect(supported.has("termchat")).toBe(true);
    expect(supported.has("tmux")).toBe(true);
    // A dependency-only source package is still built.
    expect(supported.has("stb-source")).toBe(true);
    // Declared under [[exclusions]], so setup does not build it.
    expect(supported.has("texlive")).toBe(false);
    // Products are not packages.
    expect(supported.has("browser-main-shell")).toBe(false);
  });

  it("counts every package the set builds, however it is declared", () => {
    const set = readLocalSupportedSet(`schema = 1
dependency_only = [
  "src-a", # a comment
  "src-b",
]

[[packages]]
name = "app"
class = "user-software"

[[packages]]
name = "gone"
class = "user-software"

[[products]]
id = "browser-app"
package = "app-vfs"
package_dependencies = ["init"]
root_mirror_packages = ["kernel"]

[[exclusions]]
name = "gone"
reason = "deferred"
`);
    expect([...set.builtPackages].sort()).toEqual([
      "app",
      "app-vfs",
      "init",
      "kernel",
      "src-a",
      "src-b",
    ]);
    expect([...set.activeProducts]).toEqual(["browser-app"]);
  });

  it("checks the published artifacts behind the browser's virtual modules", () => {
    expect(virtualModuleDemands().map((demand) => demand.binary).sort()).toEqual([
      "kandelo_image_module32.wasm",
      "kernel.wasm",
      "programs/wasm32/rootfs.vfs.zst",
    ]);
    expect(
      unpublishedBinaryDemands("/nonexistent-kandelo-root", [
        { binary: "kernel.wasm", consumers: ["browser @kernel-wasm module"] },
      ]),
    ).toEqual(["kernel.wasm: not published (needed by browser @kernel-wasm module)"]);
  });

  it("reports a binary whose producer the supported set does not build", () => {
    const demands = [
      { binary: "programs/wasm32/termchat.wasm", consumers: ["SHELL_LAZY_BINARY_SPECS termchat"] },
      { binary: "programs/wasm32/tmux.wasm", consumers: ["browser @binaries import"] },
      { binary: "programs/wasm32/ghost.wasm", consumers: ["browser @binaries import"] },
    ];
    const owners = new Map([
      ["programs/wasm32/termchat.wasm", { packageName: "termchat" }],
      ["programs/wasm32/tmux.wasm", { packageName: "tmux" }],
    ]);
    expect(classifyUnsupplied(demands, owners, new Set(["tmux"]))).toEqual([
      "programs/wasm32/termchat.wasm: produced by termchat, which " +
        "packages/sets/local-supported.toml does not build " +
        "(needed by SHELL_LAZY_BINARY_SPECS termchat)",
      "programs/wasm32/ghost.wasm: no registry package declares this output " +
        "(needed by browser @binaries import)",
    ]);
  });
});
