require "shellwords"

class Libxml2 < Formula
  desc "XML parser library for Kandelo"
  homepage "https://gitlab.gnome.org/GNOME/libxml2/-/wikis/home"
  url "https://download.gnome.org/sources/libxml2/2.13/libxml2-2.13.8.tar.xz"
  sha256 "277294cb33119ab71b2bc81f2f445e9bc9435b893ad15bb2cd2b0e859a0ee84a"
  license "MIT"

  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "lib/libxml2.a"

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
    shell_output("cd #{root.shellescape} && #{argv} < /dev/null")
  end

  def install
    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://download.gnome.org/sources/libxml2/2.13/libxml2-#{version}.tar.xz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "277294cb33119ab71b2bc81f2f445e9bc9435b893ad15bb2cd2b0e859a0ee84a"
    ENV["WASM_POSIX_DEP_ZLIB_DIR"] = Formula["automattic/kandelo-homebrew/zlib"].opt_prefix
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/libxml2/build-libxml2.sh"

    lib.install out_dir/"lib/libxml2.a"
    include.install out_dir/"include/libxml"
    (lib/"pkgconfig").install out_dir/"lib/pkgconfig/libxml-2.0.pc"
    inreplace lib/"pkgconfig/libxml-2.0.pc", /^prefix=.*/, "prefix=#{prefix}"
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)
    zlib = Formula["automattic/kandelo-homebrew/zlib"].opt_prefix

    test_src = testpath/"libxml2_basic.c"
    test_wasm = testpath/"libxml2_basic.wasm"
    FileUtils.cp "#{root}/packages/registry/libxml2/test/libxml2_basic.c", test_src

    system "#{kandelo_tool_prefix}-cc",
      "-I#{include}",
      "-I#{zlib}/include",
      test_src,
      "#{lib}/libxml2.a",
      "#{zlib}/lib/libz.a",
      "-lm",
      "-o",
      test_wasm
    assert_equal "\0asm".b, File.binread(test_wasm, 4)

    output = run_kandelo_wasm(root, test_wasm)
    assert_match "PASS", output
    assert_match "prefix=#{prefix}", File.read(lib/"pkgconfig/libxml-2.0.pc")
  end
end
