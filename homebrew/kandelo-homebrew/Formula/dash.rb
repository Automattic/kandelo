require "shellwords"
require_relative "../Kandelo/kandelo_formula_support"

class Dash < Formula
  include KandeloFormulaSupport

  desc "POSIX shell for Kandelo"
  homepage "http://gondor.apana.org.au/~herbert/dash/"
  url "http://gondor.apana.org.au/~herbert/dash/files/dash-0.5.12.tar.gz"
  sha256 "6a474ac46e8b0b32916c4c60df694c82058d3297d8b385b74508030ca4a8f28a"
  license all_of: ["BSD-3-Clause", "GPL-2.0-or-later"]

  bottle do
    root_url "https://ghcr.io/v2/automattic/kandelo-homebrew"
    sha256 cellar: :any_skip_relocation, wasm32_kandelo: "b07b39e7eb19324f49bd6ab23cad020354f4bcbf5602a6b6936a2633969888b8"
  end

  skip_clean "bin/dash"

  def install
    root = kandelo_root
    configure_kandelo_environment(root)
    ENV["DASH_VERSION"] = version.to_s
    out_dir = prepare_kandelo_package_env(source_url: "http://gondor.apana.org.au/~herbert/dash/files/dash-0.5.12.tar.gz", source_sha256: "6a474ac46e8b0b32916c4c60df694c82058d3297d8b385b74508030ca4a8f28a")
    system "bash", "#{root}/packages/registry/dash/build-dash.sh"
    install_kandelo_wasm(out_dir, "dash.wasm", "dash")
  end

  test do
    assert_kandelo_wasm "dash"
    assert_match "dash-homebrew-smoke", shell_output_kandelo_wasm("dash", ["-c", "echo dash-homebrew-smoke"])
  end
end
