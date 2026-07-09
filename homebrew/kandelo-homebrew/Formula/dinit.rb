require_relative "../Kandelo/formula_support/kandelo_package"

class Dinit < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://github.com/davmac314/dinit/archive/refs/tags/v0.19.4.tar.gz"
  SOURCE_SHA256 = "3c0f624eb958f8e884631be4ef687da1e475ebaa6241e7ee330b864e6cd9e30b"

  desc "Service supervisor and init system for Kandelo"
  homepage "https://github.com/davmac314/dinit"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "Apache-2.0"

  depends_on "automattic/kandelo-homebrew/libcxx"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("dinit", "build-dinit.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "DINIT_VERSION" => "v#{version}",
        "WASM_POSIX_DEP_LIBCXX_DIR" => Formula["automattic/kandelo-homebrew/libcxx"].opt_prefix,
      })
    %w[dinit dinitctl dinitcheck].each do |tool|
      kandelo_install_bin(out_dir, "#{tool}.wasm", tool)
    end
  end

  test do
    output = kandelo_run_wasm(bin/"dinit", ["--version"])
    assert_match "dinit", output.downcase
  end
end
