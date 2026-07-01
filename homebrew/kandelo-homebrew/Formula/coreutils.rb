require_relative "../Kandelo/formula_support/kandelo_package"

class Coreutils < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftpmirror.gnu.org/gnu/coreutils/coreutils-9.6.tar.xz"
  SOURCE_SHA256 = "7a0124327b398fd9eb1a6abde583389821422c744ffa10734b24f557610d3283"

  ALIASES = %w(
    cat ls cp mv rm mkdir rmdir ln chmod chown head tail wc sort uniq tr cut
    paste tee true false yes env printenv printf expr test [ basename dirname
    readlink realpath stat touch date sleep id whoami uname hostname pwd dd od
    md5sum sha256sum base64 seq factor nproc du df
  ).freeze

  desc "GNU core utilities multicall binary for Kandelo"
  homepage "https://www.gnu.org/software/coreutils/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "GPL-3.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("coreutils", "build-coreutils.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "COREUTILS_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "coreutils.wasm", "coreutils")
    kandelo_install_bin_aliases("coreutils", ALIASES)
  end

  test do
    output = kandelo_run_wasm(bin/"coreutils", ["--coreutils-prog=printf", "ok\n"])
    assert_match "ok", output
  end
end
