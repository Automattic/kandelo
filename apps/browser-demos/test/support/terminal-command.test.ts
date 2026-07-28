import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  assertTerminalCommandResult,
  buildParentShellProbe,
  buildTerminalCommand,
  parseTerminalCommandResult,
  type TerminalCommandProtocol,
  type TerminalCommandResult,
} from "./terminal-command.ts";

function execute(protocol: TerminalCommandProtocol): {
  transcript: string;
  result: TerminalCommandResult;
} {
  const output = execFileSync(
    "/bin/bash",
    ["--noprofile", "--norc", "-c", protocol.command],
    {
      encoding: "utf8",
    },
  );
  const result = parseTerminalCommandResult(output, protocol);
  assert.ok(result, "completed protocol must contain a parseable result");
  return { transcript: output, result };
}

test("multiline Bash source uses one physical terminal line and preserves heredocs", () => {
  const source = `
set -eu
IFS= read -r first <<'KANDELO_INPUT'
one value
KANDELO_INPUT
cat <<'KANDELO_OUTPUT'
line one
line two's quote
KANDELO_OUTPUT
printf '<%s>' "$first"
`.trim();
  const protocol = buildTerminalCommand(source, "multiline1");

  assert.doesNotMatch(protocol.command, /[\r\n]/);
  assert.equal(protocol.command.includes("line one"), false);
  assert.equal(protocol.command.includes(protocol.startMarker), false);
  assert.equal(protocol.command.includes(protocol.endMarker), false);

  const { result } = execute(protocol);
  assert.deepEqual(result, {
    output: "line one\nline two's quote\n<one value>",
    exitCode: 0,
  });
});

test("a parent-shell probe observes the interactive shell rather than child Bash", () => {
  const protocol = buildParentShellProbe(`printf '<%s>' "$0"`, "parentshell1");
  assert.doesNotMatch(protocol.command, /[\r\n]/);
  assert.equal(protocol.command.includes(protocol.startMarker), false);
  assert.equal(protocol.command.includes(protocol.endMarker), false);
  const output = execFileSync(
    "/bin/bash",
    ["--noprofile", "--norc", "-c", protocol.command, "outer-shell-name"],
    { encoding: "utf8" },
  );
  const result = parseTerminalCommandResult(output, protocol);

  assert.deepEqual(result, {
    output: "<outer-shell-name>",
    exitCode: 0,
  });
});

test("an echoed command cannot satisfy completion or expected-output checks", () => {
  const protocol = buildTerminalCommand(": # KANDELO_ONLY_IN_SOURCE", "echo1");
  const echoedOnly = `kandelo$ ${protocol.command}`;

  assert.equal(protocol.command.includes("KANDELO_ONLY_IN_SOURCE"), false);
  assert.equal(parseTerminalCommandResult(echoedOnly, protocol), undefined);

  const { transcript, result } = execute(protocol);
  const withEcho = `${echoedOnly}${transcript}`;
  assert.deepEqual(parseTerminalCommandResult(withEcho, protocol), result);
  assert.throws(
    () => assertTerminalCommandResult(result, "KANDELO_ONLY_IN_SOURCE"),
    /completed without KANDELO_ONLY_IN_SOURCE/,
  );
});

test("a nonzero outcome fails even when earlier output contains the expected text", () => {
  const protocol = buildTerminalCommand(
    "printf 'KANDELO_BEFORE_FAILURE\\n'; exit 23",
    "failure23",
  );
  const { result } = execute(protocol);

  assert.deepEqual(result, {
    output: "KANDELO_BEFORE_FAILURE\n",
    exitCode: 23,
  });
  assert.throws(
    () => assertTerminalCommandResult(result, "KANDELO_BEFORE_FAILURE"),
    /exited with status 23/,
  );
});

test("successful command validation returns its exact framed output", () => {
  const protocol = buildTerminalCommand(
    "printf 'alpha\\nbeta without newline'",
    "exact1",
  );
  const { result } = execute(protocol);

  assert.equal(result.output, "alpha\nbeta without newline");
  assert.equal(
    assertTerminalCommandResult(result, /^alpha\nbeta without newline$/),
    result,
  );
});
