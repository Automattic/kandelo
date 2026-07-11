require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Less < Formula
  include KandeloFormulaSupport

  desc "Terminal pager for Kandelo"
  homepage "https://www.greenwoodsoftware.com/less/"
  url "https://www.greenwoodsoftware.com/less/less-668.tar.gz"
  sha256 "2819f55564d86d542abbecafd82ff61e819a3eec967faa36cd3e68f1596a44b8"
  license "GPL-3.0-or-later"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "ee8799015db23b073bb5f6f3c16953c07613f1c5dd16488cca16c9008da6c061"
  end

  skip_clean "bin/less"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["LESS_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(source_url: "https://www.greenwoodsoftware.com/less/less-668.tar.gz", source_sha256: "2819f55564d86d542abbecafd82ff61e819a3eec967faa36cd3e68f1596a44b8")
    system "bash", "#{root}/packages/registry/less/build-less.sh"
    install_kandelo_wasm(out_dir, "less.wasm", "less")
  end

  test do
    assert_kandelo_wasm "less"
    assert_match "less", shell_output_kandelo_wasm("less", ["--version"])
  end
end
