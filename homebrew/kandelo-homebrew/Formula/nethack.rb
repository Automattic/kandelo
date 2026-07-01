require_relative "../Kandelo/formula_support/kandelo_package"

class Nethack < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://www.nethack.org/download/3.6.7/nethack-367-src.tgz"
  SOURCE_SHA256 = "98cf67df6debf9668a61745aa84c09bcab362e5d33f5b944ec5155d44d2aacb2"

  desc "NetHack dungeon exploration game for Kandelo"
  homepage "https://www.nethack.org/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "NGPL"

  depends_on "automattic/kandelo-homebrew/ncurses"

  skip_clean "bin"
  skip_clean "share/nethack"

  def install
    ncurses = Formula["automattic/kandelo-homebrew/ncurses"].opt_prefix
    out_dir = kandelo_build_package("nethack", "build-nethack.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "NETHACK_VERSION" => version.to_s,
        "WASM_POSIX_DEP_NCURSES_DIR" => ncurses,
      })
    kandelo_install_bin(out_dir, "nethack.wasm", "nethack")
    (share/"nethack").install Dir["#{out_dir}/runtime/share/nethack/*"]
  end

  test do
    output = kandelo_run_wasm(bin/"nethack", ["--version"])
    assert_match "NetHack Version", output
  end
end
