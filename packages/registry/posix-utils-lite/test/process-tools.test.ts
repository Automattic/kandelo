import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const pgrep = tryResolveBinary("programs/posix-utils-lite/pgrep.wasm");
const ps = tryResolveBinary("programs/posix-utils-lite/ps.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const artifactsAvailable = !!dash && !!pgrep && !!ps && !!coreutils;

describe.skipIf(!artifactsAvailable)("posix-utils-lite process tools", () => {
  it("reports authoritative child and process state", async () => {
    const result = await runCentralizedProgram({
      programPath: dash!,
      argv: [
        "dash",
        "-c",
        [
          "pgrep -P $$",
          'echo "NO_CHILD_RC=$?"',
          "sleep 30 & child=$!",
          'echo "CHILD=$child"',
          "pgrep -P $$",
          'echo "MATCH_RC=$?"',
          'ps -p "$child" -o pid,nice',
          'echo "PS_RC=$?"',
          'ps -o pid= -p "$child"',
          'echo "PS_NO_HEADER_RC=$?"',
          'ps -p "$child" -o unsupported_field >/dev/null 2>&1',
          'echo "PS_BAD_RC=$?"',
          'kill "$child"',
          'wait "$child" 2>/dev/null',
          'ps -o pid= -p "$child"',
          'echo "REAPED_RC=$?"',
          "pgrep --unsupported >/dev/null 2>&1",
          'echo "PGREP_BAD_RC=$?"',
        ].join("; "),
      ],
      env: ["PATH=/bin:/usr/bin", "HOME=/tmp"],
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines[0]).toBe("NO_CHILD_RC=1");

    const child = Number(lines.find((line) => line.startsWith("CHILD="))?.slice(6));
    expect(Number.isInteger(child) && child > 0).toBe(true);
    expect(lines).toContain(String(child));
    expect(lines).toContain("MATCH_RC=0");
    expect(lines.some((line) => /^PID\s+NICE$/.test(line))).toBe(true);
    expect(lines.some((line) => new RegExp(`^${child}\\s+0$`).test(line))).toBe(
      true,
    );
    expect(lines).toContain("PS_RC=0");
    expect(lines).toContain("PS_NO_HEADER_RC=0");
    expect(lines).toContain("PS_BAD_RC=2");
    expect(lines).toContain("REAPED_RC=1");
    expect(lines).toContain("PGREP_BAD_RC=2");

    const childOccurrences = lines.filter((line) => line === String(child));
    // One line from pgrep and one from the headerless ps invocation. The
    // reaped-process probe must not fabricate a third row.
    expect(childOccurrences).toHaveLength(2);
  }, 40_000);
});
