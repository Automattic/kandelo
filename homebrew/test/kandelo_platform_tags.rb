# frozen_string_literal: true

overlay = ARGV.shift || ENV["HOMEBREW_KANDELO_OVERLAY"]
if overlay && !overlay.empty?
  Utils.send(:remove_const, :Bottles) if defined?(Utils::Bottles)
  Object.send(:remove_const, :Hardware) if defined?(Hardware)
  Object.send(:remove_const, :GitHubPackages) if defined?(GitHubPackages)

  load File.join(overlay, "hardware.rb")
  load File.join(overlay, "utils/bottles.rb")
  mac_bottles = File.join(overlay, "extend/os/mac/utils/bottles.rb")
  load mac_bottles if File.exist?(mac_bottles)
  load File.join(overlay, "github_packages.rb")
else
  require "hardware"
  require "utils/bottles"
  require "github_packages"
end

require "bottle_specification"
require "bottle"

def assert(condition, label)
  raise label unless condition
end

def assert_equal(expected, actual, label)
  return if expected == actual

  raise "#{label}: expected #{expected.inspect}, got #{actual.inspect}"
end

def assert_tag_round_trip(symbol, arch)
  tag = Utils::Bottles::Tag.from_symbol(symbol)

  assert_equal(:kandelo, tag.system, "#{symbol} system")
  assert_equal(arch, tag.arch, "#{symbol} arch")
  assert_equal(symbol, tag.to_sym, "#{symbol} to_sym")
  assert_equal(symbol.to_s, tag.to_s, "#{symbol} to_s")
  assert_equal(symbol, tag.to_unstandardized_sym, "#{symbol} to_unstandardized_sym")
  assert(tag.kandelo?, "#{symbol} kandelo? predicate")
  assert_equal("/home/linuxbrew/.linuxbrew", tag.default_prefix, "#{symbol} default_prefix")
  assert_equal("/home/linuxbrew/.linuxbrew/Cellar", tag.default_cellar, "#{symbol} default_cellar")
end

assert_tag_round_trip(:wasm32_kandelo, :wasm32)
assert_tag_round_trip(:wasm64_kandelo, :wasm64)

wasm32_tag = Utils::Bottles::Tag.new(system: :kandelo, arch: :wasm32)
wasm64_tag = Utils::Bottles::Tag.new(system: :kandelo, arch: :wasm64)

ENV["HOMEBREW_KANDELO_BOTTLE_TAG"] = "wasm32_kandelo"
assert_equal(wasm32_tag, Utils::Bottles.tag, "env-selected current tag")
ENV.delete("HOMEBREW_KANDELO_BOTTLE_TAG")

spec = BottleSpecification.new
spec.sha256 cellar: :any_skip_relocation,
            wasm32_kandelo: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
spec.sha256 cellar: "/home/linuxbrew/.linuxbrew/Cellar",
            wasm64_kandelo: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

assert(spec.tag?(wasm32_tag), "wasm32 current tag selects formula bottle")
assert(spec.tag?(wasm64_tag), "wasm64 current tag selects formula bottle")

wasm32_spec = spec.tag_specification_for(wasm32_tag)
wasm64_spec = spec.tag_specification_for(wasm64_tag)

assert_equal(:any_skip_relocation, wasm32_spec.cellar, "wasm32 formula cellar")
assert_equal("/home/linuxbrew/.linuxbrew/Cellar", wasm64_spec.cellar, "wasm64 formula cellar")

stored_tags = spec.checksums.map { |entry| entry.fetch("tag") }
assert(stored_tags.include?(:wasm32_kandelo), "formula DSL stores wasm32_kandelo")
assert(stored_tags.include?(:wasm64_kandelo), "formula DSL stores wasm64_kandelo")
assert(!stored_tags.include?(:x86_64_wasm32_kandelo), "formula DSL does not synthesize x86_64_wasm32_kandelo")
assert(!stored_tags.include?(:x86_64_wasm64_kandelo), "formula DSL does not synthesize x86_64_wasm64_kandelo")

assert_equal(
  "https://ghcr.io/v2/kandelo-dev/tap-core",
  GitHubPackages.root_url("Kandelo-dev", "homebrew-tap-core"),
  "generated Homebrew package root remains canonical",
)
repository_root = "https://ghcr.io/v2/Kandelo-dev/homebrew-tap-core"
normalized_repository_root = "https://ghcr.io/v2/kandelo-dev/homebrew-tap-core"
assert_equal(
  normalized_repository_root,
  GitHubPackages.root_url_if_match(repository_root),
  "explicit GitHub package repository root retains homebrew prefix",
)
canonical_tap_root = "https://ghcr.io/v2/kandelo-dev/tap-core"
assert_equal(
  canonical_tap_root,
  GitHubPackages.root_url_if_match(canonical_tap_root),
  "explicit canonical tap root remains unchanged",
)
repository_spec = BottleSpecification.new
repository_spec.root_url(repository_root)
assert_equal(
  normalized_repository_root,
  repository_spec.root_url,
  "Formula bottle metadata retains explicit repository root",
)
bottle_digest = "a" * 64
repository_spec.sha256(
  cellar: :any_skip_relocation,
  wasm32_kandelo: bottle_digest,
)
repository_bottle = Bottle.new(
  nil,
  repository_spec,
  Utils::Bottles::Tag.from_symbol(:wasm32_kandelo),
  name: "zlib",
  pkg_version: PkgVersion.parse("1.3.1"),
)
assert_equal(
  "#{normalized_repository_root}/zlib/blobs/sha256:#{bottle_digest}",
  repository_bottle.url,
  "repository-rooted bottle blob URL",
)
assert_equal(
  CurlGitHubPackagesDownloadStrategy,
  repository_bottle.resource.download_strategy,
  "repository-rooted bottle download strategy",
)

puts "Kandelo Homebrew platform tags and package roots round-trip"
