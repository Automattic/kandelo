require_relative "../Kandelo/formula_support/kandelo_package"

class Zip < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://downloads.sourceforge.net/infozip/zip30.tar.gz"
  SOURCE_SHA256 = "f0e8bb1f9b7eb0b01285495a2699df3a4b766784c1765a8f1aeedf63c0806369"

  desc "Info-ZIP zip for Kandelo"
  homepage "https://infozip.sourceforge.net/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "Info-ZIP"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("zip", "build-zip.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "ZIP_VERSION" => "30" })
    kandelo_install_bin(out_dir, "zip.wasm", "zip")
  end

  test do
    output = kandelo_run_wasm(bin/"zip", ["-v"])
    assert_match "zip", output.downcase
  end
end
