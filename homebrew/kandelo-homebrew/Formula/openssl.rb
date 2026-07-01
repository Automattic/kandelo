require "shellwords"

class Openssl < Formula
  desc "TLS and cryptography library for Kandelo"
  homepage "https://www.openssl.org/"
  url "https://github.com/openssl/openssl/releases/download/openssl-3.3.2/openssl-3.3.2.tar.gz"
  sha256 "2e8a40b01979afe8be0bbfb3de5dc1c6709fedb46d6c89c10da114ab5fc3d281"
  license "Apache-2.0"

  skip_clean "lib/libssl.a"
  skip_clean "lib/libcrypto.a"

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
    ENV["WASM_POSIX_SYSROOT"] = "#{root}/#{kandelo_arch == "wasm64" ? "sysroot64" : "sysroot"}"
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
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://github.com/openssl/openssl/releases/download/openssl-#{version}/openssl-#{version}.tar.gz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "2e8a40b01979afe8be0bbfb3de5dc1c6709fedb46d6c89c10da114ab5fc3d281"
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/openssl/build-openssl.sh"

    lib.install out_dir/"lib/libssl.a"
    lib.install out_dir/"lib/libcrypto.a"
    include.install out_dir/"include/openssl"
    (lib/"pkgconfig").install out_dir/"lib/pkgconfig/libssl.pc"
    (lib/"pkgconfig").install out_dir/"lib/pkgconfig/libcrypto.pc"
    inreplace lib/"pkgconfig/libssl.pc", /^prefix=.*/, "prefix=#{prefix}"
    inreplace lib/"pkgconfig/libcrypto.pc", /^prefix=.*/, "prefix=#{prefix}"
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)

    test_src = testpath/"ssl_basic.c"
    test_wasm = testpath/"ssl_basic.wasm"
    FileUtils.cp "#{root}/packages/registry/openssl/test/ssl_basic.c", test_src

    system "#{kandelo_tool_prefix}-cc",
      "-I#{include}",
      test_src,
      "#{lib}/libssl.a",
      "#{lib}/libcrypto.a",
      "-ldl",
      "-o",
      test_wasm
    assert_equal "\0asm".b, File.binread(test_wasm, 4)

    output = run_kandelo_wasm(root, test_wasm)
    assert_match "PASS", output
    assert_match "prefix=#{prefix}", File.read(lib/"pkgconfig/libssl.pc")
  end
end
