import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type Zippable, zipSync } from "fflate";

import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import {
  extractZipEntry,
  parseZipCentralDirectory,
} from "../../../../host/src/vfs/zip";
import { runCentralizedProgram } from
  "../../../../host/test/centralized-test-helper";
import { buildImage } from "../../../../tools/mkrootfs/src/builder";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "../../../..");
const rubyBinary = tryResolveBinary("programs/ruby/ruby.wasm");
const rubyRuntime = tryResolveBinary("programs/ruby/ruby-runtime.zip");
const scratch = mkdtempSync(join(tmpdir(), "kandelo-portable-ruby-"));
const portableRubyVersion = "4.0.5_1";
const portableRubyRoot =
  "/opt/nonstandard-prefix/Library/Homebrew/vendor/portable-ruby";
const portableRubyVersionRoot = `${portableRubyRoot}/${portableRubyVersion}`;
const portableRubyCurrent = `${portableRubyRoot}/current`;
const portableRubyBinary = `${portableRubyCurrent}/bin/ruby`;
const portableRubyRealBinary = `${portableRubyVersionRoot}/bin/ruby`;

let rootfsImage: Uint8Array;

function repoRelative(path: string): string {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

describe.skipIf(!rubyBinary || !rubyRuntime)(
  "upstream-style portable Ruby on Kandelo",
  () => {
    beforeAll(async () => {
      const portableArchive = join(scratch, "portable-ruby.zip");
      writeFileSync(
        portableArchive,
        createPortableRubyArchive(rubyBinary!, rubyRuntime!),
      );
      const manifest = join(scratch, "MANIFEST");
      writeFileSync(
        manifest,
        [
          "/opt d 0755 0 0",
          "/opt/nonstandard-prefix d 0755 0 0",
          "/opt/nonstandard-prefix/Library d 0755 0 0",
          "/opt/nonstandard-prefix/Library/Homebrew d 0755 0 0",
          "/opt/nonstandard-prefix/Library/Homebrew/vendor d 0755 0 0",
          `${portableRubyRoot} d 0755 0 0`,
          `${portableRubyVersionRoot} d 0755 0 0`,
          `archive url=${repoRelative(portableArchive)} ` +
            `base=${portableRubyVersionRoot} ` +
            "fmode=0644 fmode_policy=preserve-executable dmode=0755 uid=0 gid=0",
          `${portableRubyCurrent} l 0777 0 0 target=${portableRubyVersion}`,
          "",
        ].join("\n"),
      );
      rootfsImage = await buildImage({
        sourceTree: join(repositoryRoot, "images/rootfs"),
        manifest,
        repoRoot: repositoryRoot,
        sabSize: 128 * 1024 * 1024,
        maxSizeBytes: 256 * 1024 * 1024,
      });
    }, 120_000);

    afterAll(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    it("loads the real msgpack and Bootsnap native extensions", async () => {
      const program = String.raw`
require "rbconfig"
# Homebrew invokes Ruby with --disable=gems, then deliberately restores its
# controlled RubyGems environment in standalone/init.rb before loading the
# generated Bundler setup, portable Ruby gems, and Bootsnap. Keep this test on
# that upstream ordering so it does not rely on Ruby's automatic gem startup.
require "rubygems"
require "portable_ruby_gems"
require "msgpack"
require "bootsnap"

# Keep representative CRuby standard extensions on their ordinary dynamic
# loading path too. This catches a portable archive that happens to carry the
# two Homebrew gems correctly but omits or statically substitutes the runtime
# extension tree that upstream Ruby expects.
%w[
  date digest/md5 etc fcntl io/console json psych socket stringio strscan zlib
].each { |feature| require feature }

expected_prefix = ${JSON.stringify(portableRubyVersionRoot)}
unless RbConfig.ruby == ${JSON.stringify(portableRubyRealBinary)}
  warn "Ruby did not retain its invoked portable path: #{RbConfig.ruby}"
  exit 9
end
unless RbConfig::CONFIG.fetch("prefix") == expected_prefix
  warn "Ruby did not relocate its prefix: #{RbConfig::CONFIG.fetch("prefix")}"
  exit 10
end

unless Bootsnap::LoadPathCache.supported?
  warn "Bootsnap rejected #{RUBY_PLATFORM}"
  exit 11
end

Bootsnap.setup(
  cache_dir: "/tmp/portable-ruby-cache",
  development_mode: false,
  load_path_cache: true,
  compile_cache_iseq: false,
  compile_cache_yaml: false,
)

decoded = MessagePack.unpack(MessagePack.pack("answer" => 42))
unless decoded == { "answer" => 42 }
  warn "msgpack round trip failed: #{decoded.inspect}"
  exit 12
end

# Native Ruby extensions hold VALUEs in C locals across calls that can trigger
# collection. Force that exact boundary here: without local-root spilling on
# the Wasm side module itself, Bootsnap's two-array result can be reclaimed and
# replaced by an unrelated live object before scan_dir returns.
GC.stress = true
3.times do |iteration|
  scan = Bootsnap::LoadPathCache::Native.scan_dir(
    "#{expected_prefix}/lib/ruby/4.0.0",
  )
  unless scan.is_a?(Array) && scan.length == 2 && scan.all?(Array)
    warn "Bootsnap GC root corruption at iteration #{iteration}: #{scan.inspect}"
    exit 13
  end
end
GC.stress = false

require "set"
puts "portable-ruby=#{RUBY_VERSION}"
puts "portable-prefix=#{RbConfig::CONFIG.fetch("prefix")}"
puts "platform=#{RUBY_PLATFORM}"
puts "bootsnap-load-path-cache=#{Bootsnap::LoadPathCache.enabled?}"
puts "msgpack-answer=#{decoded.fetch("answer")}"
`;

      const result = await runCentralizedProgram({
        programPath: rubyBinary!,
        argv: [portableRubyBinary, "--disable=gems,rubyopt", "-e", program],
        env: ["HOME=/tmp", "TMPDIR=/tmp"],
        rootfsImage,
        timeout: 180_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      expect(result.stdout).toBe([
        "portable-ruby=4.0.5",
        `portable-prefix=${portableRubyVersionRoot}`,
        "platform=wasm32-none",
        "bootsnap-load-path-cache=true",
        "msgpack-answer=42",
        "",
      ].join("\n"));
    }, 240_000);
  },
);

/** Compose the same versioned tree shape used by upstream portable Ruby. */
function createPortableRubyArchive(
  binaryPath: string,
  runtimePath: string,
): Uint8Array {
  const runtimeBytes = new Uint8Array(readFileSync(runtimePath));
  const archive: Zippable = {};
  for (const entry of parseZipCentralDirectory(runtimeBytes)) {
    if (!entry.fileName.startsWith("usr/")) {
      throw new Error(`Ruby runtime member escapes usr/: ${entry.fileName}`);
    }
    const portablePath = entry.fileName.slice("usr/".length);
    if (portablePath.length === 0) continue;
    archive[portablePath] = [extractZipEntry(runtimeBytes, entry), {
      level: entry.isDirectory ? 0 : 9,
      mtime: new Date(1980, 0, 1, 0, 0, 0),
      os: 3,
      attrs: ((entry.mode << 16) >>> 0),
    }];
  }
  if (archive["bin/ruby"] !== undefined) {
    throw new Error("Ruby runtime unexpectedly already contains bin/ruby");
  }
  archive["bin/ruby"] = [new Uint8Array(readFileSync(binaryPath)), {
    level: 9,
    mtime: new Date(1980, 0, 1, 0, 0, 0),
    os: 3,
    attrs: ((0o100755 << 16) >>> 0),
  }];
  return zipSync(archive, { level: 9 });
}
