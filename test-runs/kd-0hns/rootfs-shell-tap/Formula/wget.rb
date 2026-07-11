require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Wget < Formula
  include KandeloFormulaSupport

  desc "GNU Wget network downloader for Kandelo"
  homepage "https://www.gnu.org/software/wget/"
  url "https://ftpmirror.gnu.org/gnu/wget/wget-1.25.0.tar.gz"
  sha256 "766e48423e79359ea31e41db9e5c289675947a7fcf2efdcedb726ac9d0da3784"
  license "GPL-3.0-or-later"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "7d7b48ed79816e1c2e3812b68d4f0eb82d1178118a37d1b01cf0ee7e38f1a5ad"
  end

  skip_clean "bin/wget"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["WGET_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(source_url: "https://ftpmirror.gnu.org/gnu/wget/wget-1.25.0.tar.gz", source_sha256: "766e48423e79359ea31e41db9e5c289675947a7fcf2efdcedb726ac9d0da3784")
    system "bash", "#{root}/packages/registry/wget/build-wget.sh"
    install_kandelo_wasm(out_dir, "wget.wasm", "wget")
  end

  test do
    assert_kandelo_wasm "wget"
    assert_match(/GNU Wget|Wget/i, shell_output_kandelo_wasm("wget", ["--version"]))
  end
end
