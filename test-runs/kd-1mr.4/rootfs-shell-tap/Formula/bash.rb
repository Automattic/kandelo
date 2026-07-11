require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Bash < Formula
  include KandeloFormulaSupport

  desc "Bourne-Again SHell for Kandelo"
  homepage "https://www.gnu.org/software/bash/"
  url "https://ftpmirror.gnu.org/gnu/bash/bash-5.2.37.tar.gz"
  sha256 "9599b22ecd1d5787ad7d3b7bf0c59f312b3396d1e281175dd1f8a4014da621ff"
  license "GPL-3.0-or-later"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "d853cbef2e1f55db3995918c974adf83bd126a0c6ac0d2d3c80a9ff19ab44fdb"
  end

  skip_clean "bin/bash"

  # bash links libtinfo from ncurses, resolved through Kandelo's build-deps
  # resolver at build time; the Kandelo package dependency is recorded in the
  # generated sidecar, keeping VFS planning data out of Formula Ruby.

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["BASH_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(
      source_url: "https://ftpmirror.gnu.org/gnu/bash/bash-5.2.37.tar.gz",
      source_sha256: "9599b22ecd1d5787ad7d3b7bf0c59f312b3396d1e281175dd1f8a4014da621ff",
    )
    system "bash", "#{root}/packages/registry/bash/build-bash.sh"
    install_kandelo_wasm(out_dir, "bash.wasm", "bash")
  end

  test do
    assert_kandelo_wasm "bash"
    assert_match "bash-homebrew-smoke",
      shell_output_kandelo_wasm("bash", ["-c", "echo bash-homebrew-smoke"])
  end
end
