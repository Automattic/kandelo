/**
 * yaml-smoke.ts — kd-egn1 psych/YAML runtime smoke for Ruby on Kandelo.
 *
 * Runs the built ruby.wasm under the Node kernel host (raw host-fs passthrough
 * so RUBYLIB resolves) and exercises require 'yaml' + YAML.dump/load round-trip.
 *
 * Usage:
 *   bash build.sh && bash packages/registry/ruby/build-ruby.sh
 *   npx tsx packages/registry/ruby/demo/yaml-smoke.ts
 *
 * Exit 0 + "YAML_SMOKE_PASS" on success; non-zero otherwise.
 */
import { existsSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../../../..");

// Locate the installed Ruby stdlib dir (the one containing yaml.rb). The build's
// make-install fallback may place it under ruby-install/usr/lib/ruby/<ver> or
// ruby-install/lib/ruby/<ver>; RUBY_SMOKE_LIB overrides for ad-hoc runs.
function findRubyLib(): string | null {
  if (process.env.RUBY_SMOKE_LIB) return process.env.RUBY_SMOKE_LIB;
  const roots = [
    resolve(repoRoot, "packages/registry/ruby/ruby-install/usr/lib/ruby"),
    resolve(repoRoot, "packages/registry/ruby/ruby-install/lib/ruby"),
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const ver of readdirSync(root)) {
      const dir = resolve(root, ver);
      if (existsSync(resolve(dir, "yaml.rb"))) return dir;
    }
  }
  return null;
}

const RUBY_SCRIPT = [
  "require 'yaml'",
  "data = { 'name' => 'kandelo', 'nums' => [1, 2, 3], 'nested' => { 'ok' => true, 'pi' => 3.14 } }",
  "dumped = YAML.dump(data)",
  "raise 'YAML.dump produced empty output' if dumped.nil? || dumped.empty?",
  "loaded = YAML.load(dumped)",
  "raise \"YAML round-trip mismatch: #{loaded.inspect}\" unless loaded == data",
  "pv = (defined?(Psych::VERSION) ? Psych::VERSION : 'unknown')",
  "lv = (defined?(Psych::LIBYAML_VERSION) ? Psych::LIBYAML_VERSION : 'unknown')",
  "puts \"psych=#{pv} libyaml=#{lv}\"",
  "puts 'YAML_SMOKE_PASS'",
].join("\n");

async function main() {
  const rubyWasm = resolve(repoRoot, "packages/registry/ruby/bin/ruby.wasm");
  if (!existsSync(rubyWasm)) {
    console.error("ruby.wasm not found. Run: bash packages/registry/ruby/build-ruby.sh");
    process.exit(1);
  }
  const rubyLib = findRubyLib();
  if (!rubyLib) {
    console.error("Ruby stdlib (yaml.rb) not found under ruby-install; run build-ruby.sh");
    process.exit(1);
  }

  const result = await runCentralizedProgram({
    programPath: rubyWasm,
    argv: ["ruby", "-e", RUBY_SCRIPT],
    env: [`RUBYLIB=${rubyLib}`, `HOME=/tmp`, `TMPDIR=/tmp`],
    io: new NodePlatformIO(),
    timeout: 300_000,
  });

  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const ok = result.exitCode === 0 && result.stdout.includes("YAML_SMOKE_PASS");
  process.exit(ok ? 0 : (result.exitCode || 1));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
