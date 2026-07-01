require_relative "../Kandelo/formula_support/kandelo_package"

class Findutils < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/findutils/findutils-4.10.0.tar.xz"
  SOURCE_SHA256 = "1387e0b67ff247d2abde998f90dfbf70c1491391a59ddfecb8ae698789f0a4f5"

  desc "GNU find and xargs for Kandelo"
  homepage "https://www.gnu.org/software/findutils/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("findutils", "build-findutils.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "FINDUTILS_VERSION" => version.to_s })
    %w[find xargs].each { |tool| kandelo_install_bin(out_dir, "#{tool}.wasm", tool) }
  end

  test do
    (testpath/"needle.txt").write "needle\n"
    output = kandelo_run_wasm(bin/"find", [".", "-name", "needle.txt"], env: { "KERNEL_CWD" => testpath.to_s })
    assert_match "./needle.txt", output
  end
end
