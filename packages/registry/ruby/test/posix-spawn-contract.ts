export const RUBY_VFORK_EXECUTABLE = "/bin/echo";
export const RUBY_VFORK_MISSING_EXECUTABLE =
  "/kandelo/tests/missing-ruby-vfork-target";

export const RUBY_VFORK_FAILED_EXEC_MARKER =
  "RUBY_UPSTREAM_VFORK_FAILED_EXEC_OK";
export const RUBY_VFORK_EXEC_MARKER = "RUBY_UPSTREAM_VFORK_EXEC_OK";
export const RUBY_PRIVILEGED_FORK_MARKER =
  "RUBY_PRIVILEGED_FORK_FALLBACK_OK";

export const RUBY_VFORK_FAILED_EXEC_PROGRAM = String.raw`
unless Process.uid == 1000 && Process.euid == 1000 &&
       Process.gid == 1000 && Process.egid == 1000
  warn "unexpected unprivileged credentials"
  exit 10
end

begin
  Process.spawn(${JSON.stringify(RUBY_VFORK_MISSING_EXECUTABLE)})
  warn "missing executable unexpectedly spawned"
  exit 11
rescue Errno::ENOENT
  puts ${JSON.stringify(RUBY_VFORK_FAILED_EXEC_MARKER)}
end
`;

export const RUBY_VFORK_EXEC_PROGRAM = String.raw`
unless Process.uid == 1000 && Process.euid == 1000
  warn "successful spawn did not run as uid 1000"
  exit 12
end

pid = Process.spawn(
  { "FROM" => "ruby-upstream-vfork" },
  [${JSON.stringify(RUBY_VFORK_EXECUTABLE)}, "ruby-vfork-child"],
  "argument-one",
)
waited, status = Process.wait2(pid)
unless waited == pid && status.exited? && status.exitstatus == 42
  warn "unexpected exec child status: #{status.inspect}"
  exit 13
end
puts ${JSON.stringify(RUBY_VFORK_EXEC_MARKER)}
`;

export const RUBY_PRIVILEGED_FORK_PROGRAM = String.raw`
unless Process.uid == 0 && Process.euid == 0
  warn "privileged fallback did not run as root"
  exit 14
end

begin
  Process.spawn(${JSON.stringify(RUBY_VFORK_MISSING_EXECUTABLE)})
  warn "root spawn unexpectedly bypassed ordinary-fork admission"
  exit 15
rescue Errno::ENOMEM
  puts ${JSON.stringify(RUBY_PRIVILEGED_FORK_MARKER)}
end
`;
