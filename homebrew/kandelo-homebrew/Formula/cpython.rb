require_relative "../Kandelo/formula_support/kandelo_package"

class Cpython < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://www.python.org/ftp/python/3.13.3/Python-3.13.3.tar.xz"
  SOURCE_SHA256 = "40f868bcbdeb8149a3149580bb9bfd407b3321cd48f0be631af955ac92c0e041"
  PYTHON_STDLIB = "3.13"

  desc "CPython interpreter for Kandelo"
  homepage "https://www.python.org/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "Python-2.0"

  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("cpython", "build-cpython.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "PYTHON_VERSION" => version.to_s,
        "WASM_POSIX_DEP_ZLIB_DIR" => Formula["automattic/kandelo-homebrew/zlib"].opt_prefix.to_s,
      })
    kandelo_install_bin(out_dir, "python.wasm", "cpython")
    kandelo_install_bin_aliases("cpython", %w[python python3])
    install_stdlib(kandelo_root)
  end

  test do
    assert_predicate lib/"python#{PYTHON_STDLIB}/re/__init__.py", :exist?
    output = kandelo_run_wasm(bin/"cpython", ["-S", "-c", "import os; print(os.path.join('a', 'b'))"],
      env: {
        "PYTHONHOME" => prefix,
        "PYTHONDONTWRITEBYTECODE" => "1",
        "PYTHONNOUSERSITE" => "1",
      })
    assert_match /^a\/b$/m, output
  end

  def install_stdlib(root)
    src = first_existing_dir(
      buildpath/"kandelo-package-work/cpython-src/Lib",
      Pathname.new(root)/"packages/registry/cpython/cpython-src/Lib",
    )
    odie "CPython stdlib source not found at #{src}" unless src.directory?

    dest = lib/"python#{PYTHON_STDLIB}"
    rm_rf dest
    mkdir_p dest
    FileUtils.cp_r "#{src}/.", dest
    FileUtils.rm_rf dest/"re"
    FileUtils.cp_r src/"re", dest/"re"
    FileUtils.rm_rf Dir["#{dest}/**/__pycache__"]
    FileUtils.rm_f Dir["#{dest}/**/*.{pyc,pyo}"]
  end

  def first_existing_dir(*paths)
    paths.find(&:directory?) || paths.first
  end
end
