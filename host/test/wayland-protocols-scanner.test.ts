/*
 * PR2 gate for the Wayland DRI port: the host `wayland-scanner` turns
 * the vendored v1 protocol XML (packages/registry/wayland-protocols/xml)
 * into complete C marshalling glue.
 *
 * The actual work is in that package's test/generate-and-verify.sh; this
 * wrapper runs it and asserts "ALL PASS". `wayland-scanner` is provided
 * by flake.nix, so this exercises the real dev-shell toolchain — the
 * CLAUDE.md vitest gate runs inside scripts/dev-shell.sh where the
 * scanner is present. Outside the dev shell (bare `npx vitest run`) the
 * scanner is absent and the test skips, exactly like the sdl2/libffi
 * native tests skip without a host C compiler.
 *
 * Scope note: this proves scanner + XML completeness, which is what PR2
 * owns. Compiling the generated glue for wasm32 additionally needs
 * libwayland's `wayland-util.h` (PR3); the shell script does that step
 * when WAYLAND_UTIL_H is set, but the automated gate does not depend on
 * it. The wasm32 compile has been verified manually — see the PR notes.
 */
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
  it.skipIf(!hasScanner())(
    "produces the full core + xdg-shell interface set",
    () => {
      expect(existsSync(SCRIPT)).toBe(true);
      const out = execFileSync("bash", [SCRIPT], { encoding: "utf8" });
      expect(out, out).toContain("wayland-protocols: ALL PASS");
    },
  );
});
