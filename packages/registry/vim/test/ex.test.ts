/**
 * The root filesystem installs vim as ex(1): vim starts in Ex mode when
 * argv[0] is "ex". These cases drive ex the way scripts do (`ex -s file`
 * with commands on standard input) and check the file it writes. The
 * replaced posix-utils-lite ex understood only a handful of one-letter
 * commands and silently ignored addresses, substitutions, and global
 * commands while still exiting 0.
 */
import { describe, expect, it } from "vitest";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const dash = tryResolveBinary("programs/dash.wasm");
const vim = tryResolveBinary("programs/vim.wasm");
const coreutils = tryResolveBinary("programs/coreutils.wasm");
const artifactsAvailable = !!dash && !!vim && !!coreutils;

/** Quote `text` as one POSIX shell word. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

async function editWithEx(original: string, commands: string[]) {
  const execPrograms = new Map<string, string>([
    ["/bin/ex", vim!],
    ["/usr/bin/ex", vim!],
    ["/bin/cat", coreutils!],
    ["/usr/bin/cat", coreutils!],
  ]);
  const script = [
    `printf '%s' ${shellQuote(original)} > /tmp/file.txt`,
    `printf '%s\\n' ${commands.map(shellQuote).join(" ")} > /tmp/commands`,
    "ex -s /tmp/file.txt < /tmp/commands",
    'echo "EX_RC=$?"',
    "cat /tmp/file.txt",
  ].join("; ");
  return runCentralizedProgram({
    programPath: dash!,
    argv: ["dash", "-c", script],
    env: ["PATH=/bin:/usr/bin", "HOME=/tmp", "TERM=dumb"],
    execPrograms,
    timeout: 60_000,
  });
}

describe.skipIf(!artifactsAvailable)("vim as ex", () => {
  it("applies addressed, substitute, append, and global commands", async () => {
    const result = await editWithEx("one\ntwo\nthree\nfour\n", [
      "1s/one/uno/",
      "2d",
      "$a",
      "five",
      ".",
      "g/f/s/$/!/",
      "x",
    ]);
    expect(result.exitCode).toBe(0);
    const [status, ...lines] = result.stdout.split("\n");
    expect(status).toBe("EX_RC=0");
    expect(lines.join("\n")).toBe("uno\nthree\nfour!\nfive!\n");
  }, 60_000);

  it("fails a scripted edit whose command is an error", async () => {
    const result = await editWithEx("one\n", ["9d", "x"]);
    expect(result.stdout.split("\n")[0]).not.toBe("EX_RC=0");
  }, 60_000);
});
