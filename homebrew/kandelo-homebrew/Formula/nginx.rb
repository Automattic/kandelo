require "shellwords"

class Nginx < Formula
  desc "nginx HTTP server for Kandelo"
  homepage "https://nginx.org/"
  url "https://nginx.org/download/nginx-1.24.0.tar.gz"
  sha256 "77a2541637b92a621e3ee76776c8b7b40cf6d707e69ba53a940283e30ff2f55d"
  license "BSD-2-Clause"

  skip_clean "bin/nginx"

  def kandelo_root
    root = ENV["HOMEBREW_KANDELO_ROOT"] || ENV["KANDELO_HOMEBREW_KANDELO_ROOT"]
    odie "HOMEBREW_KANDELO_ROOT must point at a Kandelo checkout" if root.to_s.empty?
    root
  end

  def kandelo_arch
    ENV.fetch("HOMEBREW_KANDELO_ARCH", ENV.fetch("KANDELO_HOMEBREW_ARCH", "wasm32"))
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
    if (host_tool_path = ENV["HOMEBREW_KANDELO_HOST_TOOL_PATH"]).to_s != ""
      host_tool_path.split(File::PATH_SEPARATOR).reverse_each do |dir|
        ENV.prepend_path "PATH", dir unless dir.empty?
      end
    end
    if (llvm_bin = ENV["HOMEBREW_KANDELO_LLVM_BIN"]).to_s != ""
      ENV["WASM_POSIX_LLVM_DIR"] = llvm_bin
      ENV["LLVM_BIN"] = llvm_bin
      ENV.prepend_path "PATH", llvm_bin
    end
  end

  def run_kandelo_wasm(root, wasm, *args)
    wasm_path = testpath/"#{File.basename(wasm.to_s)}.wasm"
    FileUtils.cp wasm, wasm_path
    argv = [
      "node",
      "--experimental-wasm-exnref",
      "--import",
      "tsx/esm",
      "examples/run-example.ts",
      wasm_path.to_s,
      *args,
    ].map(&:shellescape).join(" ")
    shell_output("cd #{root.shellescape} && #{argv} < /dev/null 2>&1")
  end

  def install
    odie "nginx currently supports wasm32 only" unless kandelo_arch == "wasm32"

    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["CARGO_TARGET_DIR"] = (buildpath/"cargo-target").to_s
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://nginx.org/download/nginx-#{version}.tar.gz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "77a2541637b92a621e3ee76776c8b7b40cf6d707e69ba53a940283e30ff2f55d"
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/nginx/build-nginx.sh"
    chmod 0755, out_dir/"nginx.wasm"
    bin.install out_dir/"nginx.wasm" => "nginx"
    chmod 0755, bin/"nginx"
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)

    nginx = bin/"nginx"
    assert_equal "\0asm".b, File.binread(nginx, 4)
    assert_match "nginx", run_kandelo_wasm(root, nginx, "-v")
  end
end
