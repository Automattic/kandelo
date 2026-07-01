require "shellwords"

class Xz < Formula
  desc "XZ Utils compression tool for Kandelo"
  homepage "https://tukaani.org/xz/"
  url "https://tukaani.org/xz/xz-5.6.2.tar.xz"
  sha256 "a9db3bb3d64e248a0fae963f8fb6ba851a26ba1822e504dc0efd18a80c626caf"
  license all_of: ["GPL-2.0-or-later", "LGPL-2.1-or-later", "0BSD"]

  skip_clean "bin/xz"

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
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://tukaani.org/xz/xz-#{version}.tar.xz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "a9db3bb3d64e248a0fae963f8fb6ba851a26ba1822e504dc0efd18a80c626caf"
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = ENV.fetch("HOMEBREW_KANDELO_ARCH", ENV.fetch("KANDELO_HOMEBREW_ARCH", "wasm32"))

    system "bash", "#{root}/packages/registry/xz/build-xz.sh"
    chmod 0755, out_dir/"xz.wasm"
    bin.install out_dir/"xz.wasm" => "xz"
    chmod 0755, bin/"xz"
  end

  test do
    xz = bin/"xz"
    assert_equal "\0asm".b, File.binread(xz, 4)

    root = kandelo_root
    configure_kandelo_environment(root)

    test_wasm = testpath/"xz.wasm"
    File.binwrite(test_wasm, File.binread(xz))
    output = shell_output(
      "cd #{root.shellescape} && node --experimental-wasm-exnref --import tsx/esm examples/run-example.ts #{test_wasm.to_s.shellescape} --version < /dev/null",
    )
    assert_match "xz", output.scrub
  end
end
