require_relative "../Kandelo/formula_support/kandelo_package"

class Tcl < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://prdownloads.sourceforge.net/tcl/tcl8.6.16-src.tar.gz"
  SOURCE_SHA256 = "91cb8fa61771c63c262efb553059b7c7ad6757afa5857af6265e4b0bdc2a14a5"

  desc "Tcl interpreter for Kandelo"
  homepage "https://www.tcl.tk/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "TCL"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("tcl", "build-tcl.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "TCL_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "tclsh.wasm", "tcl")
    kandelo_install_bin_aliases("tcl", %w[tclsh])

    runtime = out_dir/"lib/tcl8.6"
    lib.install runtime if runtime.directory?
  end

  test do
    output = kandelo_run_wasm(bin/"tcl", [], input: "puts [expr {2 + 5}]\n",
      env: { "TCL_LIBRARY" => (lib/"tcl8.6").to_s })
    assert_match "7", output
  end
end
