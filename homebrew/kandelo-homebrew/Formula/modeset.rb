require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Modeset < Formula
  include KandeloFormulaSupport

  desc "DRI/GLES framebuffer fluid simulation for Kandelo"
  homepage "https://github.com/brandonpayton/kandelo"
  url "https://github.com/Automattic/kandelo/archive/1ab41fe2ad5553f4fa4bb0223f2d804b13149578.tar.gz"
  sha256 "446dd26b6e3f909f25f21f77950a3b11a07c633721dbff698a85b4f05fbbc493"
  version "0.1.0"
  license "GPL-2.0-or-later"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "48002a330c17971fed6d7edf71872e0cce9552c8bfb3b18813092f936e14ca88"
  end

  skip_clean "bin/modeset"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    out_dir = prepare_kandelo_package_env(source_url: "https://github.com/Automattic/kandelo/archive/1ab41fe2ad5553f4fa4bb0223f2d804b13149578.tar.gz", source_sha256: "446dd26b6e3f909f25f21f77950a3b11a07c633721dbff698a85b4f05fbbc493")
    system "bash", "#{root}/packages/registry/modeset/build-modeset.sh"
    install_kandelo_wasm(out_dir, "modeset.wasm", "modeset")
  end

  test do
    assert_kandelo_wasm "modeset"
  end
end
