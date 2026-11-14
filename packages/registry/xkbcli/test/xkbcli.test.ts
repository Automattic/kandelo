/**
 * xkbcli compile-keymap prints the keymap libxkbcommon compiles from the
 * default RMLVO names (evdev, pc105, us) and the XKB data at
 * /usr/share/X11/xkb.
 *
 * xkbcli runs the subcommand by exec of
 * /usr/libexec/xkbcommon/xkbcli-compile-keymap, so the test proves both
 * the dispatch and the compile. The root holds the xkeyboard-config tree
 * sway ships.
 *
 * compile-keymap reads a keymap from stdin when stdin is a pipe or a
 * regular file, so dash gives it /dev/null, as a sway binding does.
 *
 * Requires the normal xkbcli, dash and sway package artifacts. A missing
 * artifact is a provisioning failure, not passing or skipped coverage.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { sessionRootfs } from "../../../../host/test/wlroots-session";
import { resolveBinary } from "../../../../host/src/binary-resolver";

const xkbcli = resolveBinary("programs/xkbcli/xkbcli.wasm");
const compileKeymap = resolveBinary("programs/xkbcli/xkbcli-compile-keymap.wasm");
const dash = resolveBinary("programs/dash.wasm");

describe("xkbcli — keymap compilation from the XKB data", () => {
  it(
    "prints the default keymap through xkbcli compile-keymap",
    async () => {
      const result = await runCentralizedProgram({
        programPath: dash,
        argv: ["dash", "-c", "xkbcli compile-keymap < /dev/null"],
        env: ["PATH=/usr/bin", "HOME=/tmp"],
        execPrograms: new Map([
          ["/usr/bin/xkbcli", xkbcli],
          ["/usr/libexec/xkbcommon/xkbcli-compile-keymap", compileKeymap],
        ]),
        rootfsImage: await sessionRootfs("sway", []),
        timeout: 60_000,
      });
      const output = `stdout=${result.stdout.slice(0, 2000)}\nstderr=${result.stderr}`;

      expect(result.exitCode, output).toBe(0);
      expect(result.stdout, output).toMatch(/^xkb_keymap \{\n/);
      expect(result.stdout, output).toContain('xkb_keycodes "evdev_aliases(qwerty)"');
      expect(result.stdout, output).toContain('xkb_symbols "pc_us_inet(evdev)"');
      expect(result.stdout, output).toMatch(/key <AC01>\s*\{[^}]*\[\s*a,\s*A\s*\]/);
    },
    90_000,
  );
});
