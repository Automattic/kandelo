require_relative "../Kandelo/formula_support/kandelo_package"

class Sed < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/sed/sed-4.9.tar.xz"
  SOURCE_SHA256 = "6e226b732e1cd739464ad6862bd1a1aba42d7982922da7a53519631d24975181"

  desc "GNU stream editor for Kandelo"
  homepage "https://www.gnu.org/software/sed/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("sed", "build-sed.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "SED_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "sed.wasm", "sed")
  end

  test do
    output = kandelo_run_wasm(bin/"sed", ["s/a/b/"], input: "a\n")
    assert_equal "b\n", output
  end
end
