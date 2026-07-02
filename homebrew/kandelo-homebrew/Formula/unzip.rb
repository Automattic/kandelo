require_relative "../Kandelo/formula_support/kandelo_package"

class Unzip < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://downloads.sourceforge.net/infozip/unzip60.tar.gz"
  SOURCE_SHA256 = "036d96991646d0449ed0aa952e4fbe21b476ce994abc276e49d30e686708bd37"

  desc "Info-ZIP unzip for Kandelo"
  homepage "https://infozip.sourceforge.net/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "Info-ZIP"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("unzip", "build-unzip.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "UNZIP_VERSION" => "60" })
    kandelo_install_bin(out_dir, "unzip.wasm", "unzip")
    kandelo_install_bin_aliases("unzip", %w[zipinfo funzip])
  end

  test do
    output = kandelo_run_wasm(bin/"unzip", ["-v"])
    assert_match "unzip", output.downcase
  end
end
