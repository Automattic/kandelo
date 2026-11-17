import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { readWasmCustomSectionPayload } from "../../../../host/src/constants";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";

const rubyBinary = tryResolveBinary("programs/ruby/ruby.wasm");

// Ruby declares the mprotect fiction for its fiber stack guard pages and
// compiles GC compaction out (package.toml, build-ruby.sh, README.md).
//
// Fibers do not run yet: Kandelo's CRuby coroutine backend has no context
// switch, so coroutine_transfer() fails with ENOSYS. The fiber pool allocates
// the stack, guard page included, before that, so the guard request reaches
// the kernel; without the fiction Fiber#resume would fail earlier, on the
// guard, with ENOTSUP.
const PROGRAM = `
begin
  Fiber.new { 1 }.resume
  puts "FIBER resumed"
rescue SystemCallError => e
  puts "FIBER #{e.class}: #{e.message}"
end
begin
  GC.compact
  puts "COMPACT ran"
rescue NotImplementedError
  puts "COMPACT NotImplementedError"
end
begin
  GC.auto_compact = true
  puts "AUTO_COMPACT set"
rescue NotImplementedError
  puts "AUTO_COMPACT NotImplementedError"
end
puts "OPTS #{GC::OPTS.include?("GC_COMPACTION_SUPPORTED")}"
records = 0
File.open("/dev/kmsg", File::RDONLY | File::NONBLOCK) do |io|
  loop do
    # read_nonblock: IO#sysread waits for readability on EAGAIN.
    record = begin
      io.read_nonblock(4096, exception: false)
    rescue Errno::EPIPE
      next
    end
    break if record == :wait_readable || record.nil?
    records += 1 if record.include?("pid #{Process.pid} mprotect(") &&
      record.include?("PROT_NONE) succeeded but is not enforced")
  end
end
puts "KMSG #{records}"
`;

describe.skipIf(!rubyBinary)("Ruby fiber stacks and GC compaction on Kandelo", () => {
  it("records the declared mprotect fiction in ruby.wasm", () => {
    const bytes = readFileSync(rubyBinary!);
    const payload = readWasmCustomSectionPayload(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      "kandelo.fictions",
    );
    expect(payload && new TextDecoder().decode(payload)).toBe(
      "mprotect:prot_none=accept-unenforced,prot_none_max=65536,read_only=enotsup,read_only_max=0\n",
    );
  });

  it("allocates fiber stacks on unenforced guard pages and refuses GC compaction", async () => {
    const result = await runCentralizedProgram({
      programPath: rubyBinary!,
      argv: ["ruby", "--disable-gems", "-e", PROGRAM],
      env: ["HOME=/tmp", "TMPDIR=/tmp"],
      useDefaultRootfs: false,
      timeout: 60_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe([
      "FIBER Errno::ENOSYS: Function not implemented - coroutine_transfer",
      "COMPACT NotImplementedError",
      "AUTO_COMPACT NotImplementedError",
      "OPTS false",
      // The fiber pool's guard requests reached the kernel, which logged the
      // first of this process image and no other.
      "KMSG 1",
      "",
    ].join("\n"));
  }, 240_000);
});
