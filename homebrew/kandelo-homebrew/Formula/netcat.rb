require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Netcat < Formula
  include KandeloFormulaSupport

  desc "GNU netcat network utility for Kandelo"
  homepage "https://sourceforge.net/projects/netcat/"
  url "https://downloads.sourceforge.net/project/netcat/netcat/0.7.1/netcat-0.7.1.tar.gz"
  sha256 "30719c9a4ffbcf15676b8f528233ccc54ee6cba96cb4590975f5fd60c68a066f"
  license "GPL-2.0-or-later"

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "2eec1a038a610fca2ab8d2cc6b2feff048b009288f3fa249cbbd586107bb0efd"
  end

  skip_clean "bin/nc"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["NETCAT_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(source_url: "https://downloads.sourceforge.net/project/netcat/netcat/0.7.1/netcat-0.7.1.tar.gz", source_sha256: "30719c9a4ffbcf15676b8f528233ccc54ee6cba96cb4590975f5fd60c68a066f")
    system "bash", "#{root}/packages/registry/netcat/build-netcat.sh"
    install_kandelo_wasm(out_dir, "nc.wasm", "nc")
    bin.install_symlink "nc" => "netcat"
  end

  test do
    assert_kandelo_wasm "nc"
    assert_match(/netcat|listen|connect|usage/i, shell_output_kandelo_wasm("nc", ["--help"]))
  end
end
