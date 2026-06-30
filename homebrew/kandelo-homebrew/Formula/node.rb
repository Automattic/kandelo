require "shellwords"

class Node < Formula
  desc "Node.js compatibility command backed by SpiderMonkey for Kandelo"
  homepage "https://github.com/Automattic/kandelo"
  url "https://github.com/Automattic/kandelo.git",
      revision: "1ab41fe2ad5553f4fa4bb0223f2d804b13149578"
  version "0.1.0"
  license "MPL-2.0"

  depends_on "automattic/kandelo-homebrew/spidermonkey"

  skip_clean "bin/node"

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
    if (pkg_config = ENV["HOMEBREW_KANDELO_PKG_CONFIG"]).to_s != ""
      ENV["PKG_CONFIG"] = pkg_config
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
    shell_output("cd #{root.shellescape} && #{argv} < /dev/null")
  end

  def install
    odie "node currently supports wasm32 only" unless kandelo_arch == "wasm32"

    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["CARGO_TARGET_DIR"] = (buildpath/"cargo-target").to_s
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch
    ENV["WASM_POSIX_DEP_SPIDERMONKEY_DIR"] = Formula["automattic/kandelo-homebrew/spidermonkey"].opt_libexec.to_s
    system "bash", "#{root}/packages/registry/spidermonkey-node/build-spidermonkey-node.sh"
    chmod 0755, out_dir/"node.wasm"
    bin.install out_dir/"node.wasm" => "node"
    chmod 0755, bin/"node"
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)

    runtime = bin/"node"
    assert_equal "\0asm".b, File.binread(runtime, 4)
    output = run_kandelo_wasm(root, runtime, "-e", "console.log('hello', process.arch, process.platform, process.version)")
    assert_equal "hello wasm32 linux v22.0.0", output.strip
  end
end
