import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  browserImportDemands,
  classifyUnsupplied,
  demandedPackages,
  mergeDemands,
  hostProgramDemands,
  nodeRunnerDemands,
  nodeRunnerDemandsFromSource,
  supportedPackageNames,
  unpublishedBinaryDemands,
  unsuppliedBinaryDemands,
  virtualModuleDemands,
} from "../../scripts/check-browser-binary-supply";
import { readLocalSupportedSet } from "../../scripts/local-supported-set.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

/**
 * The browser app imports some package outputs directly. Nothing but those
 * imports declares that need (a VFS image's needs are its product's package
 * closure, which the planner enforces), so each import must be an output of a
 * package the supported set builds, and a default build selects those owners
 * beside the products. Otherwise the gap surfaces later as a skipped spec or a
 * runtime 404.
 */
describe("browser binary supply", () => {
  it("every browser import is produced by a supported package", () => {
    expect(unsuppliedBinaryDemands(repoRoot)).toEqual([]);
  });

  it("collects the browser app's required imports, not local fixtures", () => {
    const binaries = browserImportDemands(repoRoot).map((demand) => demand.binary);
    expect(binaries).toContain("programs/wasm32/dash.wasm");
    // A local conformance fixture, not a package output.
    expect(binaries).not.toContain("programs/wasm32/fbtest.wasm");
    // The shell's lazy programs reach the browser through the image, not as
    // imports, so the browser app no longer names them.
    expect(binaries).not.toContain("programs/wasm32/termchat.wasm");
  });

  it("selects the Node runner's built-ins including both Node entry points", () => {
    const binaries = nodeRunnerDemands(repoRoot).map((demand) => demand.binary);
    expect(binaries).toContain("programs/wasm32/spidermonkey-node.wasm");
    expect(binaries).toContain("programs/wasm32/node.wasm");
    expect(binaries).not.toContain("programs/wasm32/echo.wasm");
    expect(hostProgramDemands(repoRoot).map((demand) => demand.binary)).toEqual(
      expect.arrayContaining(binaries),
    );
    expect(unsuppliedBinaryDemands(repoRoot)).toEqual([]);
  });

  it("discovers new declarations without executing the Node CLI", () => {
    const source = `
      throw new Error("must never execute");
      // optionalBinary("programs/comment.wasm")
      const newer = optionalBinary("programs/new.wasm", "programs/wasm64/other.wasm");
      const local = snapshotOptionalBinaryWithFallback("examples/local.wasm", "programs/local.wasm");
    `;
    expect(nodeRunnerDemandsFromSource(source).map((demand) => demand.binary)).toEqual([
      "programs/wasm32/new.wasm", "programs/wasm64/other.wasm",
    ]);
    expect(() => nodeRunnerDemandsFromSource("const x = optionalBinary(path);")).toThrow("literal");
  });

  it("names each import's owning package for a default build's selection", () => {
    const demands = [
      { binary: "programs/wasm32/dash.wasm", consumers: ["browser @binaries import"] },
      { binary: "programs/wasm32/git/git.wasm", consumers: ["browser @binaries import"] },
      { binary: "programs/wasm32/git/git-remote-http.wasm", consumers: ["browser @binaries import"] },
      { binary: "programs/wasm64/x.wasm", consumers: ["browser @binaries import"] },
      { binary: "programs/wasm32/unowned.wasm", consumers: ["browser @binaries import"] },
    ];
    const owners = new Map([
      ["programs/wasm32/dash.wasm", { packageName: "dash", arch: "wasm32" }],
      ["programs/wasm32/git/git.wasm", { packageName: "git", arch: "wasm32" }],
      ["programs/wasm32/git/git-remote-http.wasm", { packageName: "git", arch: "wasm32" }],
      ["programs/wasm64/x.wasm", { packageName: "x", arch: "wasm64" }],
    ]);
    expect(demandedPackages(demands, owners)).toEqual([
      "dash/wasm32",
      "git/wasm32",
      "x/wasm64",
    ]);
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
reason = "deferred, see #1234" # a comment
optional = true
note = 'literal #string'
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

  it("reports a body every image references once, with all its consumers", () => {
    const merged = mergeDemands([
      { binary: "programs/wasm32/tmux.wasm", consumers: ["shell.vfs.zst"], bytes: 10 },
      { binary: "programs/wasm32/tmux.wasm", consumers: ["lamp.vfs.zst"], bytes: 10 },
      { binary: "programs/wasm32/tmux.wasm", consumers: ["stale.vfs.zst"], bytes: 9 },
    ]);
    expect(merged).toEqual([
      { binary: "programs/wasm32/tmux.wasm", consumers: ["shell.vfs.zst", "lamp.vfs.zst"], bytes: 10 },
      { binary: "programs/wasm32/tmux.wasm", consumers: ["stale.vfs.zst"], bytes: 9 },
    ]);
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
