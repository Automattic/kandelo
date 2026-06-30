require "shellwords"

class Libcurl < Formula
  desc "URL transfer library for Kandelo"
  homepage "https://curl.se/libcurl/"
  url "https://curl.se/download/curl-8.11.1.tar.xz"
  sha256 "c7ca7db48b0909743eaef34250da02c19bc61d4f1dcedd6603f109409536ab56"
  license "curl"

  depends_on "automattic/kandelo-homebrew/openssl"
  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "lib/libcurl.a"

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
    else odie "libcurl is currently packaged for wasm32 only, got #{kandelo_arch}"
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
    shell_output("cd #{root.shellescape} && #{argv}")
  end

  def install
    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://curl.se/download/curl-#{version}.tar.xz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "c7ca7db48b0909743eaef34250da02c19bc61d4f1dcedd6603f109409536ab56"
    ENV["WASM_POSIX_DEP_ZLIB_DIR"] = Formula["automattic/kandelo-homebrew/zlib"].opt_prefix
    ENV["WASM_POSIX_DEP_OPENSSL_DIR"] = Formula["automattic/kandelo-homebrew/openssl"].opt_prefix
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/libcurl/build-libcurl.sh"

    lib.install out_dir/"lib/libcurl.a"
    include.install out_dir/"include/curl"
    (lib/"pkgconfig").install out_dir/"lib/pkgconfig/libcurl.pc"
    inreplace lib/"pkgconfig/libcurl.pc", /^prefix=.*/, "prefix=#{prefix}"
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)
    openssl = Formula["automattic/kandelo-homebrew/openssl"].opt_prefix
    zlib = Formula["automattic/kandelo-homebrew/zlib"].opt_prefix

    test_src = testpath/"libcurl-smoke.c"
    test_wasm = testpath/"libcurl-smoke.wasm"
    test_src.write <<~C
      #include <curl/curl.h>
      #include <stdio.h>

      int main(void) {
        CURLcode rc = curl_global_init(CURL_GLOBAL_DEFAULT);
        if (rc != CURLE_OK) {
          printf("curl_global_init failed: %d\\n", (int)rc);
          return 1;
        }
        printf("libcurl %s ok\\n", curl_version());
        curl_global_cleanup();
        return 0;
      }
    C

    system "#{kandelo_tool_prefix}-cc",
      "-I#{include}",
      "-I#{openssl}/include",
      test_src,
      "#{lib}/libcurl.a",
      "#{openssl}/lib/libssl.a",
      "#{openssl}/lib/libcrypto.a",
      "#{zlib}/lib/libz.a",
      "-ldl",
      "-lm",
      "-o",
      test_wasm
    assert_equal "\0asm".b, File.binread(test_wasm, 4)

    output = run_kandelo_wasm(root, test_wasm)
    assert_match "libcurl", output
    assert_match "prefix=#{prefix}", File.read(lib/"pkgconfig/libcurl.pc")
  end
end
