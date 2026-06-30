require "shellwords"

class Mariadb < Formula
  desc "MariaDB server and mysqltest client for Kandelo"
  homepage "https://mariadb.org/"
  url "https://archive.mariadb.org/mariadb-10.5.28/source/mariadb-10.5.28.tar.gz"
  sha256 "0b5070208da0116640f20bd085f1136527f998cc23268715bcbf352e7b7f3cc1"
  license "GPL-2.0-only"

  skip_clean "bin/mariadbd"
  skip_clean "bin/mysqltest"

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
    ENV["WASM_POSIX_SYSROOT"] = "#{root}/#{kandelo_arch == "wasm64" ? "sysroot64" : "sysroot"}"
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
      ENV["LLVM_PREFIX"] ||= File.expand_path("..", llvm_bin)
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
    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["CARGO_TARGET_DIR"] = (buildpath/"cargo-target").to_s
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://archive.mariadb.org/mariadb-#{version}/source/mariadb-#{version}.tar.gz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "0b5070208da0116640f20bd085f1136527f998cc23268715bcbf352e7b7f3cc1"
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/mariadb/build-mariadb.sh"
    chmod 0755, out_dir/"mariadbd.wasm"
    bin.install out_dir/"mariadbd.wasm" => "mariadbd"
    if (out_dir/"mysqltest.wasm").exist?
      chmod 0755, out_dir/"mysqltest.wasm"
      bin.install out_dir/"mysqltest.wasm" => "mysqltest"
    end
    chmod 0755, bin/"mariadbd"
    chmod 0755, bin/"mysqltest" if (bin/"mysqltest").exist?
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)

    server = bin/"mariadbd"
    assert_equal "\0asm".b, File.binread(server, 4)
    output = run_kandelo_wasm(root, server, "--help", "--verbose")
    assert_match "MariaDB", output
    assert_path_exists bin/"mysqltest"
  end
end
