require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Nano < Formula
  include KandeloFormulaSupport

  desc "Terminal text editor for Kandelo"
  homepage "https://www.nano-editor.org/"
  url "https://ftpmirror.gnu.org/gnu/nano/nano-8.0.tar.xz"
  sha256 "c17f43fc0e37336b33ee50a209c701d5beb808adc2d9f089ca831b40539c9ac4"
  license "GPL-3.0-or-later"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "5c9724cea03f33dbf62b4c3edafdc797d37f2ce060a8456fee3c9f50406db2f0"
  end

  skip_clean "bin/nano"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["NANO_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(source_url: "https://ftpmirror.gnu.org/gnu/nano/nano-8.0.tar.xz", source_sha256: "c17f43fc0e37336b33ee50a209c701d5beb808adc2d9f089ca831b40539c9ac4")
    system "bash", "#{root}/packages/registry/nano/build-nano.sh"
    install_kandelo_wasm(out_dir, "nano.wasm", "nano")
  end

  test do
    assert_kandelo_wasm "nano"
    assert_match(/GNU nano|nano/i, shell_output_kandelo_wasm("nano", ["--version"]))
  end
end
