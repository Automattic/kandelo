require_relative "../Kandelo/formula_support/kandelo_package"

class M4 < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/m4/m4-1.4.19.tar.xz"
  SOURCE_SHA256 = "63aede5c6d33b6d9b13511cd0be2cac046f2e70fd0a07aa9573a04a82783af96"

  desc "GNU macro processor for Kandelo"
  homepage "https://www.gnu.org/software/m4/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("m4", "build-m4.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "M4_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "m4.wasm", "m4")
  end

  test do
    output = kandelo_run_wasm(bin/"m4", [], input: "define(`x',`ok')x\n")
    assert_match "ok", output
  end
end
