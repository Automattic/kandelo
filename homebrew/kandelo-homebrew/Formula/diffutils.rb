require_relative "../Kandelo/formula_support/kandelo_package"

class Diffutils < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/diffutils/diffutils-3.10.tar.xz"
  SOURCE_SHA256 = "90e5e93cc724e4ebe12ede80df1634063c7a855692685919bfe60b556c9bd09e"

  desc "GNU diff, cmp, diff3, and sdiff for Kandelo"
  homepage "https://www.gnu.org/software/diffutils/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("diffutils", "build-diffutils.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "DIFFUTILS_VERSION" => version.to_s })
    %w[diff cmp diff3 sdiff].each { |tool| kandelo_install_bin(out_dir, "#{tool}.wasm", tool) }
  end

  test do
    output = kandelo_run_wasm(bin/"diff", ["--version"])
    assert_match "diff", output.downcase
  end
end
