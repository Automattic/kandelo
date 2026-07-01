require_relative "../Kandelo/formula_support/kandelo_package"

class Cpython < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://www.python.org/ftp/python/3.13.3/Python-3.13.3.tar.xz"
  SOURCE_SHA256 = "40f868bcbdeb8149a3149580bb9bfd407b3321cd48f0be631af955ac92c0e041"

  desc "CPython interpreter for Kandelo"
  homepage "https://www.python.org/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "Python-2.0"

  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "bin"
  skip_clean "lib/python3.13"

  def install
    out_dir = kandelo_build_package("cpython", "build-cpython.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "PYTHON_VERSION" => version.to_s,
        "WASM_POSIX_DEP_ZLIB_DIR" => Formula["automattic/kandelo-homebrew/zlib"].opt_prefix,
      })
    kandelo_install_bin(out_dir, "python.wasm", "python")
    kandelo_install_bin_aliases("python", %w[python3 cpython])
    (lib/"python3.13").install Dir["#{buildpath}/Lib/*"]
  end

  test do
    output = kandelo_run_wasm(bin/"python", ["-S", "-c", "print('python-ok')"],
      env: {
        "PYTHONHOME" => prefix.to_s,
        "PYTHONDONTWRITEBYTECODE" => "1",
        "PYTHONNOUSERSITE" => "1",
      })
    assert_match "python-ok", output
  end
end
