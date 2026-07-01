require_relative "../Kandelo/formula_support/kandelo_package"

class PosixUtilsLite < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://raw.githubusercontent.com/Automattic/kandelo/1ab41fe2ad5553f4fa4bb0223f2d804b13149578/packages/registry/posix-utils-lite/src/posix-utils-lite.c"
  SOURCE_SHA256 = "e032c0e06db0035b106de0c400db5007e84037d405b6632955f1e45bfd3e1f93"

  UTILITIES = %w[
    ar asa cal cflow compress ctags cxref ed ex fuser gencat getconf gettext
    iconv ipcrm ipcs lex locale logger man more msgfmt ngettext nm patch pax
    ps renice strings strip uncompress uudecode uuencode what xgettext yacc
  ].freeze

  desc "Compact POSIX utility set for Kandelo"
  homepage "https://github.com/Automattic/kandelo"
  url SOURCE_URL, using: :nounzip
  sha256 SOURCE_SHA256
  version "0.1.0"
  license "GPL-2.0-or-later"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("posix-utils-lite", "build-posix-utils-lite.sh", SOURCE_URL, SOURCE_SHA256)
    UTILITIES.each { |utility| kandelo_install_bin(out_dir, "#{utility}.wasm", utility) }
  end

  test do
    output = kandelo_run_wasm(bin/"patch", ["patch"], input: "--- a/file\n+++ b/file\n")
    assert_match "patch", output.downcase
  end
end
