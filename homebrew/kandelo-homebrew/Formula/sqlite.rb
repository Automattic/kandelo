require "shellwords"

class Sqlite < Formula
  desc "SQLite static library for Kandelo"
  homepage "https://www.sqlite.org/"
  url "https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip"
  sha256 "6cebd1d8403fc58c30e93939b246f3e6e58d0765a5cd50546f16c00fd805d2c3"
  license "blessing"

  def kandelo_root
    root = ENV["HOMEBREW_KANDELO_ROOT"] || ENV["KANDELO_HOMEBREW_KANDELO_ROOT"]
    odie "HOMEBREW_KANDELO_ROOT must point at a Kandelo checkout" if root.to_s.empty?
    root
  end

  def kandelo_arch
    ENV.fetch("HOMEBREW_KANDELO_ARCH", ENV.fetch("KANDELO_HOMEBREW_ARCH", "wasm32"))
  end

  def kandelo_tool_prefix
    case kandelo_arch
    when "wasm32" then "wasm32posix"
    when "wasm64" then "wasm64posix"
    else odie "unsupported HOMEBREW_KANDELO_ARCH=#{kandelo_arch}"
    end
  end

  def configure_kandelo_environment(root)
    %w[
      CC CXX OBJC OBJCXX CFLAGS CPPFLAGS CXXFLAGS LDFLAGS CPATH
      C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH SDKROOT
      MACOSX_DEPLOYMENT_TARGET
    ].each { |key| ENV.delete(key) }

    ENV.prepend_path "PATH", "#{root}/sdk/bin"
    if (node = ENV["HOMEBREW_KANDELO_NODE"]).to_s != ""
      ENV.prepend_path "PATH", File.dirname(node)
    end
    if (llvm_bin = ENV["HOMEBREW_KANDELO_LLVM_BIN"]).to_s != ""
      ENV["WASM_POSIX_LLVM_DIR"] = llvm_bin
      ENV["LLVM_BIN"] = llvm_bin
      ENV.prepend_path "PATH", llvm_bin
    end
  end

  def install
    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://www.sqlite.org/2025/sqlite-amalgamation-3490100.zip"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "6cebd1d8403fc58c30e93939b246f3e6e58d0765a5cd50546f16c00fd805d2c3"
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/sqlite/build-sqlite.sh"
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
    assert_equal "\0asm".b, File.binread(test_wasm, 4)

    output = shell_output(
      "cd #{root.shellescape} && node --experimental-wasm-exnref --import tsx/esm examples/run-example.ts #{test_wasm.to_s.shellescape} < /dev/null",
    )
    assert_match "PASS", output
    assert_match "prefix=#{prefix}", File.read(lib/"pkgconfig/sqlite3.pc")
  end
end
