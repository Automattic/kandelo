require_relative "../Kandelo/formula_support/kandelo_package"

class Php < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://www.php.net/distributions/php-8.3.2.tar.xz"
  SOURCE_SHA256 = "4ffa3e44afc9c590e28dc0d2d31fc61f0139f8b335f11880a121b9f9b9f0634e"

  desc "PHP CLI and FPM runtime for Kandelo"
  homepage "https://www.php.net/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "PHP-3.01"

  depends_on "automattic/kandelo-homebrew/libxml2"
  depends_on "automattic/kandelo-homebrew/openssl"
  depends_on "automattic/kandelo-homebrew/sqlite"
  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "bin"
  skip_clean "lib/php/extensions"

  def install
    out_dir = kandelo_build_package("php", "build-php.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "PHP_VERSION" => version.to_s,
        "WASM_POSIX_DEP_LIBXML2_DIR" => Formula["automattic/kandelo-homebrew/libxml2"].opt_prefix,
        "WASM_POSIX_DEP_OPENSSL_DIR" => Formula["automattic/kandelo-homebrew/openssl"].opt_prefix,
        "WASM_POSIX_DEP_SQLITE_DIR" => Formula["automattic/kandelo-homebrew/sqlite"].opt_prefix,
        "WASM_POSIX_DEP_ZLIB_DIR" => Formula["automattic/kandelo-homebrew/zlib"].opt_prefix,
      })
    kandelo_install_bin(out_dir, "php.wasm", "php")
    kandelo_install_bin(out_dir, "php-fpm.wasm", "php-fpm")
    (lib/"php/extensions").install out_dir/"opcache.so"
  end

  test do
    output = kandelo_run_wasm(bin/"php", ["-r", "echo 'php-ok\\n';"])
    assert_equal "php-ok\n", output
  end
end
