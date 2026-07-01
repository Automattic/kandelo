require_relative "../Kandelo/formula_support/kandelo_package"

class Bash < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/bash/bash-5.2.37.tar.gz"
  SOURCE_SHA256 = "9599b22ecd1d5787ad7d3b7bf0c59f312b3396d1e281175dd1f8a4014da621ff"

  desc "GNU Bourne Again SHell for Kandelo"
  homepage "https://www.gnu.org/software/bash/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  depends_on "automattic/kandelo-homebrew/ncurses"

  skip_clean "bin"

  def install
    ncurses = Formula["automattic/kandelo-homebrew/ncurses"].opt_prefix
    out_dir = kandelo_build_package("bash", "build-bash.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "BASH_VERSION_PKG" => version.to_s,
        "WASM_POSIX_DEP_NCURSES_DIR" => ncurses,
      })
    kandelo_install_bin(out_dir, "bash.wasm", "bash")
  end

  test do
    output = kandelo_run_wasm(bin/"bash", ["-c", "echo bash-ok"], env: { "TERM" => "dumb" })
    assert_equal "bash-ok\n", output
  end
end
