import assert from "node:assert/strict";
import test from "node:test";

import type {
  HomebrewGuestObservedScriptResult,
} from "./homebrew_guest_lifecycle_runner";
import {
  assertHomebrewSystemCommandSpawnProof,
  createHomebrewSystemCommandSpawnProofScript,
  HOMEBREW_SYSTEM_COMMAND_PROOF_MARKER,
  HOMEBREW_SYSTEM_COMMAND_RUBY_SHA256,
  HOMEBREW_SYSTEM_COMMAND_SOURCE_REVISION,
  HOMEBREW_SYSTEM_COMMAND_SOURCE_SHA256,
} from "./homebrew_system_command_spawn_proof";

test("loads exact upstream SystemCommand and covers both child paths", () => {
  const script = createHomebrewSystemCommandSpawnProofScript();
  assert.equal(
    HOMEBREW_SYSTEM_COMMAND_SOURCE_REVISION,
    "d6c1be418446eec7de09fc72441ba4462282a142",
  );
  assert.match(script, new RegExp(HOMEBREW_SYSTEM_COMMAND_SOURCE_SHA256));
  assert.match(script, new RegExp(HOMEBREW_SYSTEM_COMMAND_RUBY_SHA256));
  assert.match(script, /SystemCommand\.instance_method\(:exec3\)/);
  assert.match(script, /Tty\.width\.positive\?/);
  assert.equal(script.match(/SystemCommand\.run!\(/g)?.length, 2);
  assert.match(script, /sudo: true/);
  assert.match(script, /error\.exitstatus == 127/);
  assert.match(script, /\/usr\/bin\/brew ruby -r system_command/);
});

test("accepts zero-fork spawn and one-fork missing-executable evidence", () => {
  assert.doesNotThrow(() =>
    assertHomebrewSystemCommandSpawnProof(successfulEvidence())
  );
});

test("rejects a valid helper that secretly forked", () => {
  const evidence = successfulEvidence();
  evidence.forkCountSamples = evidence.forkCountSamples.map((sample) =>
    sample.childPid === 43 ? { ...sample, count: 3n } : sample
  );
  assert.throws(
    () => assertHomebrewSystemCommandSpawnProof(evidence),
    /child 43 fork samples/,
  );
});

test("rejects fallback status, lifecycle, and retirement drift", () => {
  const wrongStatus = successfulEvidence();
  wrongStatus.processEvents = wrongStatus.processEvents.map((event) =>
    event.pid === 44 && event.kind === "exit"
      ? { ...event, exitStatus: 1 }
      : event
  );
  assert.throws(
    () => assertHomebrewSystemCommandSpawnProof(wrongStatus),
    /missing SystemCommand executable fallback lifecycle/,
  );

  const retained = successfulEvidence();
  retained.remainingObservedPids = [44];
  assert.throws(
    () => assertHomebrewSystemCommandSpawnProof(retained),
    /retained completed PIDs 44/,
  );
});

function successfulEvidence(): HomebrewGuestObservedScriptResult & {
  forkCountSamples: Array<
    HomebrewGuestObservedScriptResult["forkCountSamples"][number]
  >;
  processEvents: Array<
    HomebrewGuestObservedScriptResult["processEvents"][number]
  >;
  remainingObservedPids: number[];
} {
  return {
    stdout: [
      "HOMEBREW_SYSTEM_COMMAND_PARENT_PID=42",
      "HOMEBREW_SYSTEM_COMMAND_BASELINE_CHILD_PID=41",
      "HOMEBREW_SYSTEM_COMMAND_VALID_CHILD_PID=43",
      "HOMEBREW_SYSTEM_COMMAND_VALID_STATUS=0",
      "HOMEBREW_SYSTEM_COMMAND_MISSING_CHILD_PID=44",
      "HOMEBREW_SYSTEM_COMMAND_MISSING_STATUS=127",
      HOMEBREW_SYSTEM_COMMAND_PROOF_MARKER,
      "",
    ].join("\n"),
    stderr: "",
    processEvents: [
      { kind: "spawn", pid: 41, ppid: 42 },
      { kind: "exit", pid: 41, exitStatus: 0 },
      { kind: "spawn", pid: 43, ppid: 42 },
      { kind: "exec", pid: 43 },
      { kind: "exit", pid: 43, exitStatus: 0 },
      { kind: "spawn", pid: 44, ppid: 42 },
      { kind: "exit", pid: 44, exitStatus: 127 },
    ],
    forkCountSamples: [
      { parentPid: 42, childPid: 41, count: 2n },
      { parentPid: 42, childPid: 43, count: 2n },
      { parentPid: 42, childPid: 44, count: 3n },
    ],
    forkCountSampleFailures: [],
    remainingObservedPids: [],
  };
}
