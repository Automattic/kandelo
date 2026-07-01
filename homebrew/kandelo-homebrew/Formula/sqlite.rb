require_relative "../Kandelo/formula_support/kandelo_package"

class Sqlite < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip"
  SOURCE_SHA256 = "6cebd1d8403fc58c30e93939b246f3e6e58d0765a5cd50546f16c00fd805d2c3"

  desc "SQLite static library for Kandelo"
  homepage "https://www.sqlite.org/"
  url SOURCE_URL
  version "3.49.1"
  sha256 SOURCE_SHA256
  license "blessing"

  skip_clean "lib/libsqlite3.a"

  def install
    out_dir = kandelo_build_package("sqlite", "build-sqlite.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "SQLITE_VERSION" => version.to_s },
      wasm32_only: false)

    include.install out_dir/"include/sqlite3.h"
    include.install out_dir/"include/sqlite3ext.h"
    lib.install out_dir/"lib/libsqlite3.a"
    (lib/"pkgconfig").install out_dir/"lib/pkgconfig/sqlite3.pc"
    inreplace lib/"pkgconfig/sqlite3.pc", /^prefix=.*/, "prefix=#{prefix}"
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)

    test_src = testpath/"sqlite_basic.c"
    test_wasm = testpath/"sqlite_basic.wasm"
    FileUtils.cp "#{root}/packages/registry/sqlite/test/sqlite_basic.c", test_src

    system "#{kandelo_tool_prefix}-cc",
      "-I#{include}",
      test_src,
      "#{lib}/libsqlite3.a",
      "-lm",
      "-o",
      test_wasm
    kandelo_assert_wasm test_wasm

    output = kandelo_run_wasm(test_wasm)
    assert_match "PASS", output
    assert_match "prefix=#{prefix}", File.read(lib/"pkgconfig/sqlite3.pc")
  end
end
