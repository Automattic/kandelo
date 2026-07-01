require_relative "../Kandelo/formula_support/kandelo_package"

class Cpython < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://www.python.org/ftp/python/3.13.3/Python-3.13.3.tar.xz"
  SOURCE_SHA256 = "40f868bcbdeb8149a3149580bb9bfd407b3321cd48f0be631af955ac92c0e041"

  desc "Python interpreter for Kandelo (with standard library)"
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

    # Ship the standard library so the runtime can import re/json/etc.; the bare
    # python.wasm has no filesystem stdlib. PYTHONHOME (below) points here.
    stdlib_stage = buildpath/"python-stdlib-stage"
    system "unzip", "-q", out_dir/"python-stdlib.zip", "-d", stdlib_stage
    (prefix/"lib").install Dir["#{stdlib_stage}/lib/*"]
  end

  test do
    env = {
      "PYTHONHOME" => prefix.to_s,
      "HOME" => testpath.to_s,
      "PYTHONDONTWRITEBYTECODE" => "1",
      "PYTHONNOUSERSITE" => "1",
    }
    assert_match "python-ok", kandelo_run_wasm(bin/"python", ["-c", "print('python-ok')"], env: env)

    # Representative stdlib imports must work (re + json were the reported gap).
    prog = <<~PY
      import re, json, zlib, base64
      assert json.loads(json.dumps({"a": [1, 2, 3], "b": True})) == {"a": [1, 2, 3], "b": True}
      assert re.match(r"(\\d+)-(\\w+)", "42-foo").group(2) == "foo"
      print("stdlib-ok")
    PY
    assert_match "stdlib-ok", kandelo_run_wasm(bin/"python", ["-c", prog], env: env)
  end
end
