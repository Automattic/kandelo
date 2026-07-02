require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Ncurses < Formula
  include KandeloFormulaSupport

  desc "Terminal handling utilities (ncurses) for Kandelo"
  homepage "https://invisible-island.net/ncurses/"
  url "https://ftpmirror.gnu.org/gnu/ncurses/ncurses-6.5.tar.gz"
  sha256 "136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6"
  license "X11"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "829ba62710a56245cb7a8af904b775209952e929aeb49e2b62f8b0ac6394a1ab"
  end

  NCURSES_PROGRAMS = %w[
    clear reset tset tput tabs tic infocmp toe captoinfo infotocap
  ].freeze

  NCURSES_PROGRAMS.each { |program| skip_clean "bin/#{program}" }

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["NCURSES_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(
      source_url: "https://ftpmirror.gnu.org/gnu/ncurses/ncurses-6.5.tar.gz",
      source_sha256: "136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6",
    )
    programs_dir = buildpath/"ncurses-programs"
    ENV["WASM_POSIX_DEP_BIN_DIR"] = programs_dir.to_s
    system "bash", "#{root}/packages/registry/ncurses/build-ncurses.sh"
    NCURSES_PROGRAMS.each do |program|
      install_kandelo_wasm(programs_dir, "#{program}.wasm", program)
    end
    # out_dir keeps the link-time libncursesw/libtinfow build tree for
    # consumers that resolve ncurses; the Homebrew keg ships the utilities.
    out_dir
  end

  test do
    NCURSES_PROGRAMS.each { |program| assert_kandelo_wasm program }
    assert_match "ncurses", shell_output_kandelo_wasm("infocmp", ["-V"])
  end
end
