require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Vim < Formula
  include KandeloFormulaSupport

  desc "Vim terminal editor for Kandelo"
  homepage "https://www.vim.org/"
  url "https://github.com/vim/vim/archive/refs/tags/v9.1.0900.tar.gz"
  sha256 "30efb714ed82c5d7a1491f3e4aac6487d2c493d33c834d7ef043e6f45176772e"
  license "Vim"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "778be8fe04ce0439b260ed72c9bd81b163c60badd9e61c864864828198fee6ae"
  end

  skip_clean "bin/vim"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["VIM_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(source_url: "https://github.com/vim/vim/archive/refs/tags/v9.1.0900.tar.gz", source_sha256: "30efb714ed82c5d7a1491f3e4aac6487d2c493d33c834d7ef043e6f45176772e")
    system "bash", "#{root}/packages/registry/vim/build-vim.sh"
    install_kandelo_wasm(out_dir, "vim.wasm", "vim")
    (share/"vim").install out_dir/"runtime" if (out_dir/"runtime").directory?
  end

  test do
    assert_kandelo_wasm "vim"
    assert_match(/VIM|Vi IMproved/i, shell_output_kandelo_wasm("vim", ["--version"]))
  end
end
