require_relative "../Kandelo/formula_support/kandelo_package"

class Curl < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://curl.se/download/curl-8.11.1.tar.xz"
  SOURCE_SHA256 = "c7ca7db48b0909743eaef34250da02c19bc61d4f1dcedd6603f109409536ab56"

  desc "Command-line URL transfer tool for Kandelo"
  homepage "https://curl.se/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "curl"

  depends_on "automattic/kandelo-homebrew/libcurl"
  depends_on "automattic/kandelo-homebrew/openssl"
  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("curl", "build-curl.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "CURL_VERSION" => version.to_s,
        "WASM_POSIX_DEP_OPENSSL_DIR" => Formula["automattic/kandelo-homebrew/openssl"].opt_prefix,
        "WASM_POSIX_DEP_ZLIB_DIR" => Formula["automattic/kandelo-homebrew/zlib"].opt_prefix,
      })
    kandelo_install_bin(out_dir, "curl.wasm", "curl")
  end

  test do
    output = kandelo_run_wasm(bin/"curl", ["--version"])
    assert_match "curl", output
  end
end
