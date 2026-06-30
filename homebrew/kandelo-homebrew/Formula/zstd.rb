require_relative "../Kandelo/formula_support/kandelo_package"

class Zstd < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://github.com/facebook/zstd/releases/download/v1.5.6/zstd-1.5.6.tar.gz"
  SOURCE_SHA256 = "8c29e06cf42aacc1eafc4077ae2ec6c6fcb96a626157e0593d5e82a34fd403c1"

  desc "Zstandard compression tool for Kandelo"
  homepage "https://facebook.github.io/zstd/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license any_of: ["BSD-3-Clause", "GPL-2.0-only"]

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("zstd", "build-zstd.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "ZSTD_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "zstd.wasm", "zstd")
    kandelo_install_bin_aliases("zstd", %w[unzstd zstdcat])
  end

  test do
    output = kandelo_run_wasm(bin/"zstd", ["--version"])
    assert_match "zstandard", output.downcase
  end
end
