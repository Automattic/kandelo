require_relative "../Kandelo/formula_support/kandelo_package"

class Zlib < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz"
  SOURCE_SHA256 = "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23"

  desc "Compression library for Kandelo"
  homepage "https://zlib.net/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "Zlib"

  skip_clean "lib/libz.a"

  def install
    out_dir = kandelo_build_package("zlib", "build-zlib.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "ZLIB_VERSION" => version.to_s },
      wasm32_only: false)

    include.install out_dir/"include/zlib.h"
    include.install out_dir/"include/zconf.h"
    lib.install out_dir/"lib/libz.a"
    (lib/"pkgconfig").install out_dir/"lib/pkgconfig/zlib.pc"
    inreplace lib/"pkgconfig/zlib.pc", /^prefix=.*/, "prefix=#{prefix}"
  end

  test do
    configure_kandelo_environment(kandelo_root)

    test_src = testpath/"zlib-smoke.c"
    test_wasm = testpath/"zlib-smoke.wasm"
    test_src.write <<~C
      #include <stdio.h>
      #include <string.h>
      #include <zlib.h>

      int main(void) {
        const Bytef input[] = "ok";
        Bytef compressed[32];
        Bytef output[32];
        uLongf compressed_len = sizeof(compressed);
        uLongf output_len = sizeof(output);
        if (compress(compressed, &compressed_len, input, strlen((const char *)input)) != Z_OK) return 1;
        if (uncompress(output, &output_len, compressed, compressed_len) != Z_OK) return 2;
        output[output_len] = 0;
        printf("zlib %s %s\\n", zlibVersion(), output);
        return 0;
      }
    C

    system "#{kandelo_tool_prefix}-cc",
      "-I#{include}",
      test_src,
      "#{lib}/libz.a",
      "-o",
      test_wasm
    kandelo_assert_wasm test_wasm

    output = kandelo_run_wasm(test_wasm)
    assert_match "zlib #{version} ok", output
    assert_match "prefix=#{prefix}", File.read(lib/"pkgconfig/zlib.pc")
  end
end
