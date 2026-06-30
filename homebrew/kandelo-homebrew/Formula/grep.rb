require_relative "../Kandelo/formula_support/kandelo_package"

class Grep < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/grep/grep-3.11.tar.xz"
  SOURCE_SHA256 = "1db2aedde89d0dea42b16d9528f894c8d15dae4e190b59aecc78f5a951276eab"

  desc "GNU grep for Kandelo"
  homepage "https://www.gnu.org/software/grep/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("grep", "build-grep.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "GREP_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "grep.wasm", "grep")
  end

  test do
    output = kandelo_run_wasm(bin/"grep", ["beta"], input: "alpha\nbeta\n")
    assert_equal "beta\n", output
  end
end
