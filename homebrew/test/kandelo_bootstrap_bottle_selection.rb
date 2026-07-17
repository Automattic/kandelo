# frozen_string_literal: true

require "formula"
require "formulary"

formula_ref, expected_tag, expected_sha256, expected_root_url = ARGV
raise "usage: kandelo_bootstrap_bottle_selection.rb FORMULA TAG SHA256 ROOT_URL" if expected_root_url.nil?

def assert_equal(expected, actual, label)
  return if expected == actual

  raise "#{label}: expected #{expected.inspect}, got #{actual.inspect}"
end

assert_equal(expected_tag, ENV.fetch("HOMEBREW_KANDELO_BOTTLE_TAG"), "brew.env-selected tag")

tag = Utils::Bottles.tag
assert_equal(expected_tag.to_sym, tag.to_sym, "current Homebrew bottle tag")

formula = Formulary.factory(formula_ref)
assert_equal("kandelo-dev/tap-core", formula.tap&.name, "formula tap")

bottle = formula.bottle_for_tag(tag)
raise "#{formula.full_name} did not select a bottle for #{tag}" if bottle.nil?

assert_equal(expected_tag.to_sym, bottle.tag.to_sym, "selected bottle tag")
assert_equal(expected_sha256, bottle.resource.checksum&.hexdigest, "selected bottle sha256")
assert_equal(expected_root_url, formula.bottle_specification.root_url, "selected bottle root URL")

puts "#{formula.full_name} selected #{bottle.tag} #{bottle.resource.checksum.hexdigest}"
