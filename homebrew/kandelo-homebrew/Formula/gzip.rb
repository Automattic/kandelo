require_relative "../Kandelo/formula_support/kandelo_package"

class Gzip < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/gzip/gzip-1.13.tar.xz"
  SOURCE_SHA256 = "7454eb6935db17c6655576c2e1b0fabefd38b4d0936e0f87f48cd062ce91a057"

  desc "GNU gzip for Kandelo"
  homepage "https://www.gnu.org/software/gzip/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("gzip", "build-gzip.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "GZIP_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "gzip.wasm", "gzip")
    kandelo_install_bin_aliases("gzip", %w[gunzip zcat])
  end

  test do
    output = kandelo_run_wasm(bin/"gzip", ["--version"])
    assert_match "gzip", output.downcase
  end
end
