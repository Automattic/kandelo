/**
 * ttfx animates text on Kandelo:
 *
 *   - `ttfx --version` reports the packaged version;
 *   - an effect animates text from stdin, and its last frame holds the text.
 *
 * Requires the normal ttfx and dash package artifacts. A missing artifact is
 * a provisioning failure, not passing or skipped coverage.
 */
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { resolveBinary } from "../../../../host/src/binary-resolver";

const dash = resolveBinary("programs/dash.wasm");
const ttfx = resolveBinary("programs/ttfx.wasm");

describe("ttfx — terminal text effects", () => {
  it(
    "reports its version and animates text from stdin",
    async () => {
      const result = await runCentralizedProgram({
        programPath: dash,
        argv: [
          "dash",
          "-c",
          "ttfx --version && echo foo bar baz | ttfx --canvas-width 40 --canvas-height 3 decrypt",
        ],
        env: ["PATH=/usr/bin", "HOME=/tmp", "TERM=xterm-256color"],
        execPrograms: new Map([["/usr/bin/ttfx", ttfx]]),
        timeout: 60_000,
      });
      const output = `stdout=${JSON.stringify(result.stdout.slice(-600))}\nstderr=${result.stderr}`;

      expect(result.exitCode, output).toBe(0);
      expect(result.stderr, output).toBe("");
      expect(result.stdout, output).toMatch(/^ttfx 0\.5\.1\n/);
      const lastFrame = result.stdout.slice(result.stdout.lastIndexOf("\x1b[3A"));
      expect(lastFrame.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""), output).toContain("foo bar baz");
    },
    90_000,
  );
});
