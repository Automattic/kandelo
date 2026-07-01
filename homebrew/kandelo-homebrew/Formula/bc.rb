require_relative "../Kandelo/formula_support/kandelo_package"

class Bc < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/bc/bc-1.07.1.tar.gz"
  SOURCE_SHA256 = "62adfca89b0a1c0164c2cdca59ca210c1d44c3ffc46daf9931cf4942664cb02a"

  desc "Arbitrary precision calculator language for Kandelo"
  homepage "https://www.gnu.org/software/bc/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("bc", "build-bc.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "BC_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "bc.wasm", "bc")
  end

  test do
    output = kandelo_run_wasm(bin/"bc", [], input: "2+3\nquit\n")
    assert_match "5", output
  end
end
