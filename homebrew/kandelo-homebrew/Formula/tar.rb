require_relative "../Kandelo/formula_support/kandelo_package"

class Tar < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/tar/tar-1.35.tar.xz"
  SOURCE_SHA256 = "4d62ff37342ec7aed748535323930c7cf94acf71c3591882b26a7ea50f3edc16"

  desc "GNU tar for Kandelo"
  homepage "https://www.gnu.org/software/tar/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("tar", "build-tar.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "TAR_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "tar.wasm", "tar")
  end

  test do
    (testpath/"a.txt").write "archive\n"
    kandelo_run_wasm(bin/"tar", ["-cf", "a.tar", "a.txt"], env: { "KERNEL_CWD" => testpath.to_s })
    output = kandelo_run_wasm(bin/"tar", ["-tf", "a.tar"], env: { "KERNEL_CWD" => testpath.to_s })
    assert_match "a.txt", output
  end
end
