require "shellwords"

class Zlib < Formula
  desc "Compression library for Kandelo"
  homepage "https://zlib.net/"
  url "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"
  sha256 "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"
  license "Zlib"

  skip_clean "lib/libz.a"

  def install
    kandelo_root = ENV["HOMEBREW_KANDELO_ROOT"] || ENV["KANDELO_HOMEBREW_KANDELO_ROOT"]
    odie "HOMEBREW_KANDELO_ROOT must point at a Kandelo checkout" if kandelo_root.to_s.empty?

    ENV.prepend_path "PATH", "#{kandelo_root}/sdk/bin"
    if (node = ENV["HOMEBREW_KANDELO_NODE"]).to_s != ""
      ENV.prepend_path "PATH", File.dirname(node)
    end
    if (llvm_bin = ENV["HOMEBREW_KANDELO_LLVM_BIN"]).to_s != ""
      ENV["WASM_POSIX_LLVM_DIR"] = llvm_bin
      ENV["LLVM_BIN"] = llvm_bin
      ENV.prepend_path "PATH", llvm_bin
    end

    out_dir = buildpath/"kandelo-package-out"
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://github.com/madler/zlib/releases/download/v#{version}/zlib-#{version}.tar.gz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = ENV.fetch("HOMEBREW_KANDELO_ARCH", ENV.fetch("KANDELO_HOMEBREW_ARCH", "wasm32"))

    system "bash", "#{kandelo_root}/packages/registry/zlib/build-zlib.sh"

    inreplace out_dir/"lib/pkgconfig/zlib.pc", out_dir.to_s, prefix.to_s
    lib.install out_dir/"lib/libz.a"
    include.install out_dir/"include/zlib.h", out_dir/"include/zconf.h"
    (lib/"pkgconfig").install out_dir/"lib/pkgconfig/zlib.pc"
  end

  test do
    assert_path_exists lib/"libz.a"
    assert_path_exists include/"zlib.h"
    assert_path_exists include/"zconf.h"
    assert_path_exists lib/"pkgconfig/zlib.pc"

    kandelo_root = ENV["HOMEBREW_KANDELO_ROOT"] || ENV["KANDELO_HOMEBREW_KANDELO_ROOT"]
    return if kandelo_root.to_s.empty?

    ENV.prepend_path "PATH", "#{kandelo_root}/sdk/bin"
    if (node = ENV["HOMEBREW_KANDELO_NODE"]).to_s != ""
      ENV.prepend_path "PATH", File.dirname(node)
    end

    arch = ENV.fetch("HOMEBREW_KANDELO_ARCH", ENV.fetch("KANDELO_HOMEBREW_ARCH", "wasm32"))
    ENV["WASM_POSIX_SYSROOT"] = "#{kandelo_root}/#{arch == "wasm64" ? "sysroot64" : "sysroot"}"
    ENV["WASM_POSIX_GLUE_DIR"] = "#{kandelo_root}/libc/glue"
    %w[
      SDKROOT
      HOMEBREW_SDKROOT
      CPATH
      C_INCLUDE_PATH
      CPLUS_INCLUDE_PATH
      OBJC_INCLUDE_PATH
    ].each { |key| ENV.delete(key) }

    compiler = "#{kandelo_root}/sdk/bin/#{arch}posix-cc"
    smoke_c = testpath/"zlib-smoke.c"
    smoke_wasm = testpath/"zlib-smoke.wasm"
    smoke_c.write <<~C
      #include <stdio.h>
      #include <string.h>
      #include <zlib.h>

      int main(void) {
        const unsigned char input[] = "kandelo zlib smoke";
        unsigned char compressed[128];
        unsigned char output[128];
        unsigned long compressed_len = sizeof(compressed);
        unsigned long output_len = sizeof(output);

        if (compress(compressed, &compressed_len, input, sizeof(input)) != Z_OK) {
          puts("compress failed");
          return 1;
        }
        if (uncompress(output, &output_len, compressed, compressed_len) != Z_OK) {
          puts("uncompress failed");
          return 1;
        }
        if (output_len != sizeof(input) || memcmp(input, output, sizeof(input)) != 0) {
          puts("roundtrip mismatch");
          return 1;
        }

        printf("zlib %s ok\\n", zlibVersion());
        return 0;
      }
    C

    system compiler, smoke_c, "-I#{include}", "-L#{lib}", "-lz", "-o", smoke_wasm
    output = shell_output(
      "cd #{kandelo_root.shellescape} && node --experimental-wasm-exnref --import tsx/esm examples/run-example.ts #{smoke_wasm.to_s.shellescape} < /dev/null",
    )
    assert_match "zlib #{version} ok", output
  end
end
