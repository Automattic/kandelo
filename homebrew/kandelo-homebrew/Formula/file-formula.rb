require_relative "../Kandelo/formula_support/kandelo_package"

class FileFormula < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://astron.com/pub/file/file-5.45.tar.gz"
  SOURCE_SHA256 = "fc97f51029bb0e2c9f4e3bffefdaf678f0e039ee872b9de5c002a6d09c784d82"

  desc "File type detector for Kandelo"
  homepage "https://www.darwinsys.com/file/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "BSD-2-Clause"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("file", "build-file.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "FILE_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "file.wasm", "file")
    (share/"file").install out_dir/"magic.lite"
  end

  test do
    sample = testpath/"sample.txt"
    sample.write "kandelo\n"
    output = kandelo_run_wasm(bin/"file", ["-m", (share/"file/magic.lite").to_s, sample.to_s])
    assert_match "text", output.downcase
  end
end
