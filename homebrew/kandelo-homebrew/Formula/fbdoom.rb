require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Fbdoom < Formula
  include KandeloFormulaSupport

  desc "fbDOOM framebuffer game port for Kandelo"
  homepage "https://github.com/maximevince/fbDOOM"
  url "https://github.com/maximevince/fbDOOM.git", branch: "master"
  version "0.1.0"
  license "GPL-2.0-or-later"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "51f8e3d28b47a182dbee12dd6eb25ab1a39c4c11cb6f78da51183d442796173c"
  end

  skip_clean "bin/fbdoom"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    out_dir = prepare_kandelo_package_env(source_url: "https://github.com/maximevince/fbDOOM", source_sha256: "0000000000000000000000000000000000000000000000000000000000000000")
    system "bash", "#{root}/packages/registry/fbdoom/build-fbdoom.sh"
    install_kandelo_wasm(out_dir, "fbdoom.wasm", "fbdoom")
  end

  test do
    assert_kandelo_wasm "fbdoom"
  end
end
