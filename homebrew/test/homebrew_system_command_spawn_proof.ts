import type {
  HomebrewGuestLifecycleMachine,
  HomebrewGuestObservedScriptResult,
} from "./homebrew_guest_lifecycle_runner";
import type {
  HomebrewGuestLifecycleRuntimeInputs,
} from "./homebrew_guest_lifecycle_runtime_inputs";

export const HOMEBREW_SYSTEM_COMMAND_SOURCE_REVISION =
  "d6c1be418446eec7de09fc72441ba4462282a142";
export const HOMEBREW_SYSTEM_COMMAND_SOURCE_SHA256 =
  "85a37161fae874db80c97b3228c0471d02ddf84c6ed1c915d9615ea9eb48ae72";
export const HOMEBREW_SYSTEM_COMMAND_RUBY_SHA256 =
  "1c1e8eb34793ae1f01a20483f91d1b4b93981d8cfdc6918ee6265d9a8487f5f3";
export const HOMEBREW_SYSTEM_COMMAND_PROOF_MARKER =
  "HOMEBREW_SYSTEM_COMMAND_SPAWN_PROOF_OK";

const HOMEBREW_SYSTEM_COMMAND_SOURCE_PATH =
  "/opt/kandelo/homebrew/Library/Homebrew/system_command.rb";
const PARENT_PREFIX = "HOMEBREW_SYSTEM_COMMAND_PARENT_PID=";
const BASELINE_CHILD_PREFIX = "HOMEBREW_SYSTEM_COMMAND_BASELINE_CHILD_PID=";
const VALID_CHILD_PREFIX = "HOMEBREW_SYSTEM_COMMAND_VALID_CHILD_PID=";
const VALID_STATUS_PREFIX = "HOMEBREW_SYSTEM_COMMAND_VALID_STATUS=";
const MISSING_CHILD_PREFIX = "HOMEBREW_SYSTEM_COMMAND_MISSING_CHILD_PID=";
const MISSING_STATUS_PREFIX = "HOMEBREW_SYSTEM_COMMAND_MISSING_STATUS=";

/**
 * Exercise upstream Homebrew's real SystemCommand implementation in one
 * guest Ruby activation. The source hash binds the loaded method to the exact
 * reviewed upstream revision instead of accepting a look-alike test helper.
 */
export function createHomebrewSystemCommandSpawnProofScript(): string {
  const rubyProgram = String.raw`
require "digest"
require "rbconfig"
require "system_command"

expected_source = ${JSON.stringify(HOMEBREW_SYSTEM_COMMAND_SOURCE_PATH)}
source_location = SystemCommand.instance_method(:exec3).source_location
abort "SystemCommand#exec3 has no source location" if source_location.nil?
source_path = File.realpath(source_location.fetch(0))
abort "SystemCommand loaded from #{source_path}" unless source_path == expected_source
source_sha256 = Digest::SHA256.file(source_path).hexdigest
unless source_sha256 == ${JSON.stringify(HOMEBREW_SYSTEM_COMMAND_SOURCE_SHA256)}
  abort "SystemCommand source has digest #{source_sha256}"
end
ruby_sha256 = Digest::SHA256.file(RbConfig.ruby).hexdigest
unless ruby_sha256 == ${JSON.stringify(HOMEBREW_SYSTEM_COMMAND_RUBY_SHA256)}
  abort "Ruby executable has digest #{ruby_sha256}"
end

# WHY: the guest archive intentionally omits .git, so HOMEBREW_VERSION reports
# a generic shallow-repository value. The exact source-file digest above is
# the durable revision identity available inside the running guest.

puts "${PARENT_PREFIX}#{Process.pid}"
$stdout.flush

# WHY: SystemCommand asks Tty.width for COLUMNS before Process.spawn. Its
# first lookup runs stty and tput, whose forks are Homebrew initialization,
# not part of launching the helper under test. Initialize that memoized value
# before taking the parent counter baseline so the measured delta belongs
# solely to SystemCommand#exec3.
abort "Homebrew terminal width is invalid" unless Tty.width.positive?

# Establish the parent's current monotonic counter after Homebrew startup.
# Earlier launcher work may have forked before this Ruby program began, so an
# absolute zero would measure the launcher rather than SystemCommand#exec3.
baseline_pid = Process.spawn("/usr/bin/true")
Process.wait(baseline_pid)
abort "baseline helper returned #{$?.exitstatus}" unless $?.success?
puts "${BASELINE_CHILD_PREFIX}#{baseline_pid}"
$stdout.flush

# WHY: the host samples the parent when it observes each child spawn. Keep
# Ruby alive briefly so that asynchronous worker request completes before the
# next case changes the monotonic counter.
sleep 0.25

valid = SystemCommand.run!(
  "/usr/bin/printf",
  args: ["%s\\n", "homebrew-system-command-helper-ok"],
  print_stderr: false,
)
abort "valid helper returned #{valid.status.exitstatus}" unless valid.status.success?
unless valid.stdout == "homebrew-system-command-helper-ok\n"
  abort "valid helper returned #{valid.stdout.inspect}"
end
puts "${VALID_CHILD_PREFIX}#{valid.status.pid}"
puts "${VALID_STATUS_PREFIX}#{valid.status.exitstatus}"
$stdout.flush

# WHY: let the host sample the still-live Ruby parent's zero fork counter
# before the following fallback increments it. The counter request crosses a
# worker boundary and must not race two logically separate command cases.
sleep 0.25

begin
  # WHY: ordinary SystemCommand calls start /usr/bin/env, so a missing helper
  # would only make env return 127 after Process.spawn had already succeeded.
  # sudo makes the outer executable itself absent and therefore exercises
  # upstream Homebrew's spawn-error rescue, fork, failed exec, and 127 exit.
  SystemCommand.run!(
    "/usr/bin/printf",
    args: ["unused"],
    sudo: true,
    print_stderr: false,
  )
  abort "missing /usr/bin/sudo unexpectedly executed"
rescue ErrorDuringExecution => error
  unless error.exitstatus == 127 && error.status.is_a?(Process::Status)
    abort "missing executable returned #{error.exitstatus.inspect}"
  end
  missing_output = Array(error.output).map { |entry| entry.fetch(1) }.join
  unless missing_output.include?("/usr/bin/sudo")
    abort "missing executable diagnostic was #{missing_output.inspect}"
  end
  puts "${MISSING_CHILD_PREFIX}#{error.status.pid}"
  puts "${MISSING_STATUS_PREFIX}#{error.exitstatus}"
end

puts ${JSON.stringify(HOMEBREW_SYSTEM_COMMAND_PROOF_MARKER)}
$stdout.flush

# Keep this activation alive while the host samples the fallback's updated
# fork counter. Process.detach has already waited for both command children.
sleep 0.25
`.trim();

  return [
    "set -eu",
    `/usr/bin/brew ruby -r system_command -e ${quoteShellWord(rubyProgram)}`,
  ].join("\n");
}

export function assertHomebrewSystemCommandSpawnProof(
  result: HomebrewGuestObservedScriptResult,
): void {
  const parentPid = parseSinglePid(result.stdout, PARENT_PREFIX);
  const baselineChildPid = parseSinglePid(
    result.stdout,
    BASELINE_CHILD_PREFIX,
  );
  const validChildPid = parseSinglePid(result.stdout, VALID_CHILD_PREFIX);
  const missingChildPid = parseSinglePid(result.stdout, MISSING_CHILD_PREFIX);
  assertSingleStatus(result.stdout, VALID_STATUS_PREFIX, 0);
  assertSingleStatus(result.stdout, MISSING_STATUS_PREFIX, 127);
  assertSingleLine(result.stdout, HOMEBREW_SYSTEM_COMMAND_PROOF_MARKER);

  assertChildEvents(result, {
    label: "fork-counter baseline helper",
    parentPid,
    childPid: baselineChildPid,
    expectedKinds: ["spawn", "exit"],
    expectedExitStatus: 0,
  });
  assertChildEvents(result, {
    label: "representable SystemCommand helper",
    parentPid,
    childPid: validChildPid,
    expectedKinds: ["spawn", "exec", "exit"],
    expectedExitStatus: 0,
  });
  assertChildEvents(result, {
    label: "missing SystemCommand executable fallback",
    parentPid,
    childPid: missingChildPid,
    expectedKinds: ["spawn", "exit"],
    expectedExitStatus: 127,
  });
  const baselineForkCount = readForkCount(
    result,
    parentPid,
    baselineChildPid,
  );
  assertForkCount(result, parentPid, validChildPid, baselineForkCount);
  assertForkCount(
    result,
    parentPid,
    missingChildPid,
    baselineForkCount + 1n,
  );

  const requiredRetirements = [
    parentPid,
    baselineChildPid,
    validChildPid,
    missingChildPid,
  ];
  const retained = requiredRetirements.filter((pid) =>
    result.remainingObservedPids.includes(pid)
  );
  if (retained.length !== 0) {
    throw new Error(
      `SystemCommand proof retained completed PIDs ${retained.join(", ")}`,
    );
  }
}

export async function runHomebrewSystemCommandSpawnProof(options: {
  machine: HomebrewGuestLifecycleMachine;
  runtime: HomebrewGuestLifecycleRuntimeInputs;
  deadlineMs: number;
}): Promise<HomebrewGuestObservedScriptResult> {
  const observed = options.machine.runObservedShellScript;
  if (observed === undefined) {
    throw new Error("Homebrew SystemCommand proof lacks process observation");
  }

  let succeeded = false;
  try {
    await beforeDeadline(
      options.deadlineMs,
      "Homebrew SystemCommand proof machine start",
      () => options.machine.start(),
    );
    const timeoutMs = remainingMilliseconds(options.deadlineMs);
    const result = await beforeDeadline(
      options.deadlineMs,
      "real guest Homebrew SystemCommand proof",
      () => observed.call(options.machine, {
        shellPath: options.runtime.shellPath,
        shellArgv0: options.runtime.shellArgv0,
        script: createHomebrewSystemCommandSpawnProofScript(),
        marker: HOMEBREW_SYSTEM_COMMAND_PROOF_MARKER,
        label: "real guest Homebrew SystemCommand proof",
        timeoutMs,
      }),
      options.machine.failureContext,
    );
    assertHomebrewSystemCommandSpawnProof(result);
    if (options.machine.diagnostics.length !== 0) {
      throw new Error(
        "Homebrew SystemCommand proof emitted host diagnostics: " +
          JSON.stringify(options.machine.diagnostics),
      );
    }
    succeeded = true;
    return result;
  } finally {
    const destroying = options.machine.destroy();
    if (succeeded) {
      await beforeDeadline(
        options.deadlineMs,
        "Homebrew SystemCommand proof machine teardown",
        () => destroying,
      );
    } else {
      await destroying.catch(() => {});
    }
  }
}

function assertChildEvents(
  result: HomebrewGuestObservedScriptResult,
  expected: {
    label: string;
    parentPid: number;
    childPid: number;
    expectedKinds: readonly ("spawn" | "exec" | "exit")[];
    expectedExitStatus: number;
  },
): void {
  const events = result.processEvents.filter(
    (event) => event.pid === expected.childPid,
  );
  const spawn = events.find((event) => event.kind === "spawn");
  const exit = events.find((event) => event.kind === "exit");
  const kinds = events.map((event) => event.kind);
  if (
    spawn?.ppid !== expected.parentPid ||
    JSON.stringify(kinds) !== JSON.stringify(expected.expectedKinds) ||
    exit?.exitStatus !== expected.expectedExitStatus
  ) {
    throw new Error(
      `${expected.label} lifecycle was ${JSON.stringify(events)}`,
    );
  }
}

function assertForkCount(
  result: HomebrewGuestObservedScriptResult,
  parentPid: number,
  childPid: number,
  expected: bigint,
): void {
  const samples = result.forkCountSamples.filter(
    (sample) =>
      sample.parentPid === parentPid && sample.childPid === childPid,
  );
  if (samples.length !== 1 || samples[0]!.count !== expected) {
    const failures = result.forkCountSampleFailures.filter(
      (failure) =>
        failure.parentPid === parentPid && failure.childPid === childPid,
    );
    throw new Error(
      `SystemCommand child ${childPid} fork samples were ` +
        `${JSON.stringify(samples, bigintJson)}; failures=` +
        `${JSON.stringify(failures)}; expected=${expected}`,
    );
  }
}

function readForkCount(
  result: HomebrewGuestObservedScriptResult,
  parentPid: number,
  childPid: number,
): bigint {
  const samples = result.forkCountSamples.filter(
    (sample) =>
      sample.parentPid === parentPid && sample.childPid === childPid,
  );
  if (samples.length !== 1) {
    const failures = result.forkCountSampleFailures.filter(
      (failure) =>
        failure.parentPid === parentPid && failure.childPid === childPid,
    );
    throw new Error(
      `SystemCommand baseline child ${childPid} fork samples were ` +
        `${JSON.stringify(samples, bigintJson)}; failures=` +
        JSON.stringify(failures),
    );
  }
  return samples[0]!.count;
}

function parseSinglePid(stdout: string, prefix: string): number {
  const value = parseSingleNumericLine(stdout, prefix);
  if (value < 1) throw new Error(`${prefix} is not a positive PID`);
  return value;
}

function assertSingleStatus(
  stdout: string,
  prefix: string,
  expected: number,
): void {
  const actual = parseSingleNumericLine(stdout, prefix);
  if (actual !== expected) {
    throw new Error(`${prefix} was ${actual}, expected ${expected}`);
  }
}

function parseSingleNumericLine(stdout: string, prefix: string): number {
  const matches = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix));
  if (matches.length !== 1 || !/^[0-9]+$/.test(matches[0]!.slice(prefix.length))) {
    throw new Error(`${prefix} evidence was ${JSON.stringify(matches)}`);
  }
  const value = Number(matches[0]!.slice(prefix.length));
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${prefix} exceeds JavaScript's safe integer range`);
  }
  return value;
}

function assertSingleLine(stdout: string, expected: string): void {
  const count = stdout.split(/\r?\n/).filter((line) => line === expected).length;
  if (count !== 1) {
    throw new Error(`${expected} appeared ${count} times`);
  }
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function bigintJson(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

async function beforeDeadline<T>(
  deadlineMs: number,
  label: string,
  operation: () => Promise<T>,
  failureContext?: () => string,
): Promise<T> {
  const timeoutMs = remainingMilliseconds(deadlineMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const context = failureContext?.();
          reject(new Error(
            `${label} exceeded its total deadline` +
              (context === undefined || context === "" ? "" : `; ${context}`),
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function remainingMilliseconds(deadlineMs: number): number {
  const remaining = deadlineMs - Date.now();
  if (!Number.isSafeInteger(deadlineMs) || remaining <= 0) {
    throw new Error("Homebrew SystemCommand proof deadline has expired");
  }
  return remaining;
}
