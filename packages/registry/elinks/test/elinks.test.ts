import { afterEach, describe, expect, it } from "vitest";
import * as os from "node:os";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeHostScratchTempRoot,
  runCentralizedProgram,
} from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const elinksBinaryPath =
  tryResolveBinary("programs/elinks.wasm") ??
  join(__dirname, "../bin/elinks.wasm");
const READY = existsSync(elinksBinaryPath);
const scratchDirs: string[] = [];

afterEach(() => {
  for (const scratch of scratchDirs.splice(0)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function fixtureDir(files: Record<string, string>): string {
  const scratch = makeHostScratchTempRoot("kandelo-elinks-");
  scratchDirs.push(scratch);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scratch, name), content);
  }
  return scratch;
}

// -no-home keeps ELinks from reading or writing ~/.config/elinks, so a test
// never depends on (or leaves behind) per-user state.
const BASE_ARGS = ["-no-home", "1"];

/** Render a local file to text the way `elinks -dump` does. */
function dumpFile(path: string) {
  return runCentralizedProgram({
    programPath: elinksBinaryPath,
    argv: ["elinks", ...BASE_ARGS, "-dump", "-dump-width", "80", path],
    env: ["TERM=dumb", "HOME=/tmp"],
    io: new NodePlatformIO(),
    timeout: 60_000,
  });
}

/**
 * Load a page in ELinks's JavaScript test mode. `-test 1` makes the page's
 * `console.exit()` end the browser with status 0 when every `console.assert`
 * held and 1 otherwise, and print the tally on stderr. This is the harness
 * upstream's own test/js/assert suite runs under.
 */
function runPageScript(path: string) {
  return runCentralizedProgram({
    programPath: elinksBinaryPath,
    argv: [
      "elinks",
      ...BASE_ARGS,
      "-test", "1",
      "-eval", "set ecmascript.enable = 1",
      // console.assert only counts while console logging is on.
      "-eval", "set ecmascript.enable_console_log = 1",
      "-eval", "set ui.sessions.fork_on_start = 0",
      "-no-connect", "1",
      path,
    ],
    env: ["TERM=dumb", "HOME=/tmp"],
    io: new NodePlatformIO(),
    // ELinks starts as an interactive browser here, so it needs a terminal
    // input stream to open; an empty one is enough for a page that exits on
    // its own.
    stdin: "",
    timeout: 60_000,
  });
}

describe.skipIf(!READY)("ELinks package", () => {
  it("reports the packaged JavaScript engine and TLS library", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: elinksBinaryPath,
      argv: ["elinks", "-version"],
      io: new NodePlatformIO(),
      timeout: 60_000,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ELinks 0.20.0");
    // The feature list is wrapped to the terminal width, so compare it with
    // whitespace collapsed.
    const features = stdout.replace(/\s+/g, " ");
    expect(features).toContain("ECMAScript (QuickJS-NG 0.17.0)");
    expect(features).toContain("SSL (OpenSSL 3.3.2");
    expect(features).toContain("gzip");
    expect(features).toContain("Cascading Style Sheets");
  }, 90_000);

  it("lays out an HTML table when dumping a local file", async () => {
    const scratch = fixtureDir({
      "table.html": `<html><head><title>Table</title></head><body>
<h1>Inventory</h1>
<table border="1">
<tr><th>Name</th><th>Count</th></tr>
<tr><td>alpha</td><td>1</td></tr>
<tr><td>beta</td><td>22</td></tr>
</table>
<p>See <a href="https://example.com/more">more</a>.</p>
</body></html>
`,
    });
    const { stdout, exitCode } = await dumpFile(join(scratch, "table.html"));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Inventory");
    // Cells sit side by side inside drawn borders: that is table layout,
    // not the cell text flattened into one column.
    expect(stdout).toMatch(/│ Name\s+│ Count │/);
    expect(stdout).toMatch(/│ alpha\s+│ 1\s+│/);
    expect(stdout).toMatch(/│ beta\s+│ 22\s+│/);
    // Links are numbered in the text and listed with their targets.
    expect(stdout).toContain("[1]more");
    expect(stdout).toContain("1. https://example.com/more");
  }, 90_000);

  it("runs page JavaScript against the document", async () => {
    const scratch = fixtureDir({
      "script.html": `<html><body>
<p id="target" class="a b">original</p>
<ul><li>one</li><li>two</li><li>three</li></ul>
<script>
var target = document.getElementById("target");
console.assert(target !== null, "getElementById finds the paragraph");
console.assert(target.textContent === "original", "textContent reads");
console.assert(target.classList.contains("b"), "classList reads");
console.assert(document.querySelectorAll("li").length === 3, "querySelectorAll");

// Language features beyond ES5 prove the engine is QuickJS-NG, not a stub.
var squares = [1, 2, 3].map((n) => n ** 2);
console.assert(squares.join(",") === "1,4,9", "arrow functions and **");
console.assert(2n ** 64n === 18446744073709551616n, "BigInt arithmetic");
console.assert(new Map([["k", 1]]).get("k") === 1, "Map");
class Point { #x = 3; get x() { return this.#x; } }
console.assert(new Point().x === 3, "private class fields");
console.assert(JSON.stringify({ a: [1, { b: null }] }) === '{"a":[1,{"b":null}]}', "JSON");

// Writing to the document changes what a later read observes.
var item = document.createElement("li");
item.textContent = "four";
document.querySelector("ul").appendChild(item);
console.assert(document.querySelectorAll("li").length === 4, "appendChild");
console.exit();
</script>
</body></html>
`,
    });
    const { stderr, exitCode } = await runPageScript(join(scratch, "script.html"));
    expect(stderr).toContain("Assertions: 10, failed assertions: 0");
    expect(exitCode).toBe(0);
  }, 90_000);

  it("reports a failed page assertion through its exit status", async () => {
    // Guards the test above: an exit status that were always 0 would make
    // every JavaScript assertion pass vacuously.
    const scratch = fixtureDir({
      "failing.html": `<script>
console.assert(1 + 1 === 2, "holds");
console.assert(1 + 1 === 3, "does not hold");
console.exit();
</script>
`,
    });
    const { stderr, exitCode } = await runPageScript(join(scratch, "failing.html"));
    expect(stderr).toContain("Assertions: 2, failed assertions: 1");
    expect(exitCode).toBe(1);
  }, 90_000);
});
