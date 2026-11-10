/*
 * PR2 gate for the Wayland DRI port: the host `wayland-scanner` turns
 * the installed protocol XML (libwayland's share/wayland/wayland.xml and
 * the wayland-protocols package's share/wayland-protocols tree) into
 * complete C marshalling glue.
 *
 * The actual work is in the wayland-protocols package's
 * test/generate-and-verify.sh; this wrapper resolves both packages, runs
 * it and asserts "ALL PASS". `wayland-scanner` is provided by flake.nix,
 * so this exercises the real dev-shell toolchain — the CLAUDE.md vitest
 * gate runs inside scripts/dev-shell.sh where the scanner is present. A
 * missing scanner FAILS the test, as the sdl2/libffi native tests fail
 * without a host C compiler: it is a declared host tool
 * (packages/registry/{libwayland,wayland-demo}/package.toml), so its absence
 * is a broken toolchain to surface, not a reason to report green.
 *
 * Scope note: this proves scanner + XML completeness. Compiling the
 * generated glue for wasm32 additionally needs libwayland's
 * `wayland-util.h`; the shell script does that step when WAYLAND_UTIL_H
 * is set, but the automated gate does not depend on it.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolvePackagePrefix } from "./package-prefix";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const SCRIPT = join(
  REPO_ROOT,
  "packages/registry/wayland-protocols/test/generate-and-verify.sh",
);

function hasScanner(): boolean {
  try {
    execFileSync("wayland-scanner", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("wayland-protocols — wayland-scanner generates the v1 glue", () => {
  it(
    "produces the full core + xdg-shell interface set",
    () => {
      expect(
        hasScanner(),
        "wayland-scanner not found on PATH; run through scripts/dev-shell.sh",
      ).toBe(true);
      expect(existsSync(SCRIPT)).toBe(true);
      const libwayland = resolvePackagePrefix("libwayland");
      const protocols = resolvePackagePrefix("wayland-protocols");
      const out = execFileSync("bash", [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          WAYLAND_PKGDATADIR: join(libwayland, "share/wayland"),
          WAYLAND_PROTOCOLS_PKGDATADIR: join(
            protocols,
            "share/wayland-protocols",
          ),
        },
      });
      expect(out, out).toContain("wayland-protocols: ALL PASS");
    },
    600_000,
  );
});
