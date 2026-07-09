require_relative "../Kandelo/formula_support/kandelo_package"

class Make < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/make/make-4.4.1.tar.gz"
  SOURCE_SHA256 = "dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3"

  desc "GNU make for Kandelo"
  homepage "https://www.gnu.org/software/make/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("make", "build-make.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "MAKE_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "make.wasm", "make")
  end

  test do
    assert_match "GNU Make", kandelo_run_wasm(bin/"make", ["--version"])
  end
end
