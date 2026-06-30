require "shellwords"

class Bzip2 < Formula
  desc "bzip2 compression tool for Kandelo"
  homepage "https://sourceware.org/bzip2/"
  url "https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz"
  sha256 "ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269"
  license "bzip2-1.0.6"

  skip_clean "bin/bzip2"

  def kandelo_root
    root = ENV["HOMEBREW_KANDELO_ROOT"] || ENV["KANDELO_HOMEBREW_KANDELO_ROOT"]
    odie "HOMEBREW_KANDELO_ROOT must point at a Kandelo checkout" if root.to_s.empty?
    root
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
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://sourceware.org/pub/bzip2/bzip2-#{version}.tar.gz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269"
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = ENV.fetch("HOMEBREW_KANDELO_ARCH", ENV.fetch("KANDELO_HOMEBREW_ARCH", "wasm32"))

    system "bash", "#{root}/packages/registry/bzip2/build-bzip2.sh"
    chmod 0755, out_dir/"bzip2.wasm"
    bin.install out_dir/"bzip2.wasm" => "bzip2"
    chmod 0755, bin/"bzip2"
  end

  test do
    bzip2 = bin/"bzip2"
    assert_equal "\0asm".b, File.binread(bzip2, 4)

    root = kandelo_root
    configure_kandelo_environment(root)

    test_wasm = testpath/"bzip2.wasm"
    File.binwrite(test_wasm, File.binread(bzip2))
    output = shell_output(
      "cd #{root.shellescape} && node --experimental-wasm-exnref --import tsx/esm examples/run-example.ts #{test_wasm.to_s.shellescape} --help 2>&1",
    )
    assert_match "bzip2", output.scrub
  end
end
