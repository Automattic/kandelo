require "shellwords"

class Redis < Formula
  desc "Redis server and CLI for Kandelo"
  homepage "https://redis.io/"
  url "https://github.com/redis/redis/archive/refs/tags/7.2.5.tar.gz"
  sha256 "98a8502a2e902d2a9785ef46a69a5f8d5e24cbf9ea3ae4d845afcfc6778aa783"
  license "BSD-3-Clause"

  skip_clean "bin/redis-server"
  skip_clean "bin/redis-cli"

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
    shell_output("cd #{root.shellescape} && #{argv} < /dev/null 2>&1")
  end

  def install
    odie "redis currently supports wasm32 only" unless kandelo_arch == "wasm32"

    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["CARGO_TARGET_DIR"] = (buildpath/"cargo-target").to_s
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://github.com/redis/redis/archive/refs/tags/#{version}.tar.gz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "98a8502a2e902d2a9785ef46a69a5f8d5e24cbf9ea3ae4d845afcfc6778aa783"
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/redis/build-redis.sh"
    chmod 0755, out_dir/"redis-server.wasm"
    chmod 0755, out_dir/"redis-cli.wasm"
    bin.install out_dir/"redis-server.wasm" => "redis-server"
    bin.install out_dir/"redis-cli.wasm" => "redis-cli"
    chmod 0755, bin/"redis-server"
    chmod 0755, bin/"redis-cli"
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)

    server = bin/"redis-server"
    cli = bin/"redis-cli"
    assert_equal "\0asm".b, File.binread(server, 4)
    assert_equal "\0asm".b, File.binread(cli, 4)
    assert_match "Redis server", run_kandelo_wasm(root, server, "--version")
    assert_match "redis-cli", run_kandelo_wasm(root, cli, "--version")
  end
end
