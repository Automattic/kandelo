require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Msmtpd < Formula
  include KandeloFormulaSupport

  desc "SMTP capture daemon from msmtp for Kandelo"
  homepage "https://marlam.de/msmtp/"
  url "https://marlam.de/msmtp/releases/msmtp-1.8.32.tar.xz"
  sha256 "20cd58b58dd007acf7b937fa1a1e21f3afb3e9ef5bbcfb8b4f5650deadc64db4"
  license "GPL-3.0-or-later"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "ff2c0e456efbfe2d03b30dea2f8462a7f3818146715e3dc78ab5f21580a88691"
  end

  skip_clean "bin/msmtpd"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    out_dir = prepare_kandelo_package_env(source_url: "https://marlam.de/msmtp/releases/msmtp-1.8.32.tar.xz", source_sha256: "20cd58b58dd007acf7b937fa1a1e21f3afb3e9ef5bbcfb8b4f5650deadc64db4")
    system "bash", "#{root}/packages/registry/msmtpd/build-msmtpd.sh"
    install_kandelo_wasm(out_dir, "msmtpd.wasm", "msmtpd")
  end

  test do
    assert_kandelo_wasm "msmtpd"
    assert_match(/msmtp|msmtpd/i, shell_output_kandelo_wasm("msmtpd", ["--version"]))
  end
end
