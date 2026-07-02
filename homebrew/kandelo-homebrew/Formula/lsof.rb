require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Lsof < Formula
  include KandeloFormulaSupport

  desc "Kandelo /proc file descriptor lister"
  homepage "https://github.com/brandonpayton/kandelo"
  url "https://github.com/Automattic/kandelo/archive/1ab41fe2ad5553f4fa4bb0223f2d804b13149578.tar.gz"
  sha256 "446dd26b6e3f909f25f21f77950a3b11a07c633721dbff698a85b4f05fbbc493"
  version "0.1.0"
  license "GPL-2.0-or-later"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "104cc2d3f485eb2da330996de062cde2574aa28d693c60d875b7af0c0d534a6b"
  end

  skip_clean "bin/lsof"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    out_dir = prepare_kandelo_package_env(source_url: "https://github.com/Automattic/kandelo/archive/1ab41fe2ad5553f4fa4bb0223f2d804b13149578.tar.gz", source_sha256: "446dd26b6e3f909f25f21f77950a3b11a07c633721dbff698a85b4f05fbbc493")
    system "bash", "#{root}/packages/registry/lsof/build-lsof.sh"
    install_kandelo_wasm(out_dir, "lsof.wasm", "lsof")
  end

  test do
    assert_kandelo_wasm "lsof"
  end
end
