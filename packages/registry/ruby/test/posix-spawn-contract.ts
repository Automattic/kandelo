export const RUBY_POSIX_SPAWN_EXECUTABLE = "/usr/bin/ruby";
export const RUBY_POSIX_SPAWN_CWD = "/tmp/ruby-posix-spawn-cwd";

const childProgram = String.raw`
input = STDIN.read
argv0 = File.binread("/proc/self/cmdline").split("\0", -1).fetch(0)
puts "argv0=#{argv0}"
puts "arg1=#{ARGV.fetch(0)}"
puts "env=#{ENV.fetch('K_TEST')}"
puts "cwd=#{Dir.pwd}"
puts "pid=#{Process.pid}"
puts "pgrp=#{Process.getpgrp}"
puts "input=#{input}"
warn "stderr-ok"
exit 23
`;

export interface RubyPosixSpawnCase {
  marker: string;
  expectedForkCount: bigint;
  expectedChildEvents: readonly ("spawn" | "exec" | "exit")[];
  program: string;
}

function rubySingleQuoted(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function parentProgram(
  closeOthers: boolean,
  marker: string,
  explicitEnvironment = true,
): string {
  const closeOthersOption = closeOthers ? ",\n  close_others: true" : "";
  const environmentArgument = explicitEnvironment
    ? '  { "K_TEST" => "env-ok" },\n'
    : "";
  const expectedEnvironment = explicitEnvironment
    ? "env-ok"
    : "inherited-env-ok";
  const blockingAssertion = closeOthers
    ? ""
    : String.raw`
unless stdio_sources.all? { |io| (io.fcntl(3) & File::NONBLOCK) == 0 }
  warn "spawn did not clear O_NONBLOCK on its final standard streams"
  exit 11
end
`;
  const failedSpawnRestoration = closeOthers
    ? ""
    : String.raw`
# WHY: the direct backend clears O_NONBLOCK before entering posix_spawn so a
# successful child receives ordinary blocking standard streams. A rejected
# spawn creates no child and must restore the parent's original flags.
begin
  Process.spawn(
${environmentArgument}    [${JSON.stringify(RUBY_POSIX_SPAWN_EXECUTABLE)}, "failed-probe"],
    "--disable-gems",
    "-e",
    "exit 0",
    in: input_read,
    out: output_write,
    err: error_write,
    pgroup: true,
    chdir: "#{child_cwd}/missing",
  )
  warn "spawn unexpectedly accepted a missing working directory"
  exit 16
rescue Errno::ENOENT
end
unless stdio_sources.all? { |io| (io.fcntl(3) & File::NONBLOCK) != 0 }
  warn "failed spawn did not restore O_NONBLOCK"
  exit 17
end
`;

  return String.raw`
child_program = ${rubySingleQuoted(childProgram)}
child_cwd = ${JSON.stringify(RUBY_POSIX_SPAWN_CWD)}
Dir.mkdir(child_cwd) unless Dir.exist?(child_cwd)

input_read, input_write = IO.pipe
output_read, output_write = IO.pipe
error_read, error_write = IO.pipe
stdio_sources = [input_read, output_write, error_write]

# WHY: Kandelo's Ruby pipes are nonblocking. CRuby's fork backend clears this
# flag on the child's final standard streams, which also clears it on these
# parent descriptors because both sides share the same open-file description.
# The direct posix_spawn backend must preserve that observable behavior.
unless stdio_sources.all? { |io| (io.fcntl(3) & File::NONBLOCK) != 0 }
  warn "test setup did not create nonblocking pipes"
  exit 10
end

${failedSpawnRestoration}

pid = Process.spawn(
${environmentArgument}  [${JSON.stringify(RUBY_POSIX_SPAWN_EXECUTABLE)}, "custom-argv-zero"],
  "--disable-gems",
  "-e",
  child_program,
  "argument-one",
  in: input_read,
  out: output_write,
  err: error_write,
  pgroup: true,
  chdir: child_cwd${closeOthersOption},
)

${blockingAssertion}

input_read.close
output_write.close
error_write.close
input_write.write("pipe-input")
input_write.close

stdout = output_read.read
stderr = error_read.read
status = Process.detach(pid).value

unless status.exitstatus == 23
  warn "unexpected child status: #{status.inspect}"
  exit 12
end

lines = stdout.lines.map(&:chomp)
expected_lines = [
  "argv0=custom-argv-zero",
  "arg1=argument-one",
  "env=${expectedEnvironment}",
  "input=pipe-input",
]
unless expected_lines.all? { |line| lines.include?(line) } &&
       lines.any? { |line| line.start_with?("cwd=") && line.end_with?("/ruby-posix-spawn-cwd") }
  warn "unexpected child stdout: #{stdout.inspect}"
  exit 13
end

pid_field = stdout[/^pid=(\d+)$/, 1]
pgrp_field = stdout[/^pgrp=(\d+)$/, 1]
unless pid_field && pid_field == pgrp_field
  warn "child did not enter its own process group: #{stdout.inspect}"
  exit 14
end
unless stderr == "stderr-ok\n"
  warn "unexpected child stderr: #{stderr.inspect}"
  exit 15
end

puts ${JSON.stringify(marker)}
# Keep the parent alive briefly so a host-side fork-count query prompted by
# the child-spawn event cannot race process reaping.
sleep 0.25
`;
}

function explicitCloseFallbackProgram(marker: string): string {
  return String.raw`
begin
  Process.spawn(
    [${JSON.stringify(RUBY_POSIX_SPAWN_EXECUTABLE)}, "invalid-close"],
    "--disable-gems",
    "-e",
    "exit 0",
    999 => :close,
  )
  warn "spawn ignored an invalid explicit close"
  exit 18
rescue Errno::EBADF
end

puts ${JSON.stringify(marker)}
# Keep the parent alive briefly so the host can sample the completed fork.
sleep 0.25
`;
}

function relativeExecutableFallbackProgram(marker: string): string {
  return String.raw`
child_cwd = ${JSON.stringify(RUBY_POSIX_SPAWN_CWD)}
Dir.mkdir(child_cwd) unless Dir.exist?(child_cwd)

begin
  # WHY: Ruby resolves this slash-containing relative path after chdir. The
  # direct Kandelo spawn path resolves before its file actions, so using that
  # backend here would incorrectly find /usr/bin/ruby from the parent cwd.
  Process.spawn(
    ["usr/bin/ruby", "relative-executable"],
    "--disable-gems",
    "-e",
    "exit 0",
    chdir: child_cwd,
  )
  warn "spawn resolved a relative executable before chdir"
  exit 19
rescue Errno::ENOENT
end

puts ${JSON.stringify(marker)}
# Keep the parent alive briefly so the host can sample the completed fork.
sleep 0.25
`;
}

export const RUBY_POSIX_SPAWN_CASES: readonly RubyPosixSpawnCase[] = [
  {
    marker: "RUBY_POSIX_SPAWN_DIRECT_OK",
    expectedForkCount: 0n,
    expectedChildEvents: ["spawn", "exit"],
    // No close_others option is intentional. This is Homebrew SystemCommand's
    // shape; Ruby-created unrelated descriptors rely on ordinary CLOEXEC.
    program: parentProgram(false, "RUBY_POSIX_SPAWN_DIRECT_OK"),
  },
  {
    marker: "RUBY_POSIX_SPAWN_INHERITED_ENV_OK",
    expectedForkCount: 0n,
    expectedChildEvents: ["spawn", "exit"],
    // With no environment hash, CRuby leaves its private envp unset. The
    // direct backend must pass the current process environment explicitly.
    program: parentProgram(
      false,
      "RUBY_POSIX_SPAWN_INHERITED_ENV_OK",
      false,
    ),
  },
  {
    marker: "RUBY_POSIX_SPAWN_FORK_FALLBACK_OK",
    expectedForkCount: 1n,
    expectedChildEvents: ["spawn", "exec", "exit"],
    // Explicit descriptor sweeping is not representable by Kandelo's current
    // posix_spawn actions, so Ruby must retain its established fork backend.
    program: parentProgram(true, "RUBY_POSIX_SPAWN_FORK_FALLBACK_OK"),
  },
  {
    marker: "RUBY_POSIX_SPAWN_EXPLICIT_CLOSE_FALLBACK_OK",
    expectedForkCount: 1n,
    expectedChildEvents: ["spawn", "exit"],
    // Kandelo's spawn action ignores close(EBADF), while Ruby reports it.
    // Retaining Ruby's fork backend preserves the caller-visible exception.
    program: explicitCloseFallbackProgram(
      "RUBY_POSIX_SPAWN_EXPLICIT_CLOSE_FALLBACK_OK",
    ),
  },
  {
    marker: "RUBY_POSIX_SPAWN_RELATIVE_CHDIR_FALLBACK_OK",
    expectedForkCount: 1n,
    expectedChildEvents: ["spawn", "exit"],
    // The child must change directory before resolving this relative path.
    program: relativeExecutableFallbackProgram(
      "RUBY_POSIX_SPAWN_RELATIVE_CHDIR_FALLBACK_OK",
    ),
  },
] as const;
