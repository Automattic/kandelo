require "shellwords"

class Libpng < Formula
  desc "PNG image library for Kandelo"
  homepage "http://www.libpng.org/pub/png/libpng.html"
  url "https://download.sourceforge.net/libpng/libpng-1.6.43.tar.xz"
  sha256 "6a5ca0652392a2d7c9db2ae5b40210843c0bbc081cbd410825ab00cc59f14a6c"
  license "libpng-2.0"

  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "lib/libpng16.a"

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
    else odie "libpng is currently packaged for wasm32 only, got #{kandelo_arch}"
    end
  end

  def configure_kandelo_environment(root)
    %w[
      CC CXX OBJC OBJCXX CFLAGS CPPFLAGS CXXFLAGS LDFLAGS CPATH
      C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH SDKROOT
      MACOSX_DEPLOYMENT_TARGET
    ].each { |key| ENV.delete(key) }

    ENV.prepend_path "PATH", "#{root}/sdk/bin"
    ENV["WASM_POSIX_SYSROOT"] = "#{root}/sysroot"
    ENV["WASM_POSIX_GLUE_DIR"] = "#{root}/libc/glue"
    if (node = ENV["HOMEBREW_KANDELO_NODE"]).to_s != ""
      ENV.prepend_path "PATH", File.dirname(node)
    end
    if (llvm_bin = ENV["HOMEBREW_KANDELO_LLVM_BIN"]).to_s != ""
      ENV["WASM_POSIX_LLVM_DIR"] = llvm_bin
      ENV["LLVM_BIN"] = llvm_bin
      ENV["LLVM_PREFIX"] ||= File.expand_path("..", llvm_bin)
      ENV.prepend_path "PATH", llvm_bin
    end
  end

  def run_kandelo_wasm(root, wasm, *args)
    argv = [
      "node",
      "--experimental-wasm-exnref",
      "--import",
      "tsx/esm",
      "examples/run-example.ts",
      wasm.to_s,
      *args,
    ].map(&:shellescape).join(" ")
    shell_output("cd #{root.shellescape} && #{argv} < /dev/null")
  end

  def install
    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://download.sourceforge.net/libpng/libpng-#{version}.tar.xz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "6a5ca0652392a2d7c9db2ae5b40210843c0bbc081cbd410825ab00cc59f14a6c"
    ENV["WASM_POSIX_DEP_ZLIB_DIR"] = Formula["automattic/kandelo-homebrew/zlib"].opt_prefix
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/libpng/build-libpng.sh"

    lib.install out_dir/"lib/libpng16.a"
    include.install out_dir/"include/libpng16"
    (lib/"pkgconfig").install out_dir/"lib/pkgconfig/libpng16.pc"
    inreplace lib/"pkgconfig/libpng16.pc", /^prefix=.*/, "prefix=#{prefix}"
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)
    zlib = Formula["automattic/kandelo-homebrew/zlib"].opt_prefix

    test_src = testpath/"libpng-smoke.c"
    test_wasm = testpath/"libpng-smoke.wasm"
    test_src.write <<~C
      #include <png.h>
      #include <stdio.h>

      int main(void) {
        printf("libpng %s ok\\n", png_get_libpng_ver(NULL));
        return 0;
      }
    C

    system "#{kandelo_tool_prefix}-cc",
      "-I#{include}/libpng16",
      test_src,
      "#{lib}/libpng16.a",
      "#{zlib}/lib/libz.a",
      "-lm",
      "-o",
      test_wasm
    assert_equal "\0asm".b, File.binread(test_wasm, 4)

    output = run_kandelo_wasm(root, test_wasm)
    assert_match "libpng #{version} ok", output
    assert_match "prefix=#{prefix}", File.read(lib/"pkgconfig/libpng16.pc")
  end
end
