require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Git < Formula
  include KandeloFormulaSupport

  desc "Distributed revision control system for Kandelo"
  homepage "https://git-scm.com/"
  url "https://github.com/git/git/archive/refs/tags/v2.47.1.tar.gz"
  sha256 "30654cc6c0142fa68050cc7b0ee6a2a65944288b907821781112efaf24293b23"
  license "GPL-2.0-only"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "2ba2c7ce61393c99a06aff34744973b55bbd9e28ded2303e2f98d2363b39295f"
  end

  skip_clean "bin/git"
  skip_clean "bin/git-remote-http"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["GIT_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(source_url: "https://github.com/git/git/archive/refs/tags/v2.47.1.tar.gz", source_sha256: "30654cc6c0142fa68050cc7b0ee6a2a65944288b907821781112efaf24293b23")
    system "bash", "#{root}/packages/registry/git/build-git.sh"
    install_kandelo_wasm(out_dir, "git.wasm", "git")
    install_kandelo_wasm(out_dir, "git-remote-http.wasm", "git-remote-http")
    bin.install_symlink "git-remote-http" => "git-remote-https"
    bin.install_symlink "git-remote-http" => "git-remote-ftp"
    bin.install_symlink "git-remote-http" => "git-remote-ftps"
  end

  test do
    assert_kandelo_wasm "git"
    assert_kandelo_wasm "git-remote-http"
    assert_match "git version", shell_output_kandelo_wasm("git", ["--version"])
  end
end
