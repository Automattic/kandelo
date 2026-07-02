require_relative "../Kandelo/formula_support/kandelo_package"

class Gawk < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/gawk/gawk-5.3.0.tar.xz"
  SOURCE_SHA256 = "ca9c16d3d11d0ff8c69d79dc0b47267e1329a69b39b799895604ed447d3ca90b"

  desc "GNU awk for Kandelo"
  homepage "https://www.gnu.org/software/gawk/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("gawk", "build-gawk.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "GAWK_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "gawk.wasm", "gawk")
  end

  test do
    output = kandelo_run_wasm(bin/"gawk", ["BEGIN { print 6 * 7 }"])
    assert_match "42", output
  end
end
