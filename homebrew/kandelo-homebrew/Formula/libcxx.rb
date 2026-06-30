require "shellwords"

class Libcxx < Formula
  desc "LLVM libc++ and libc++abi static libraries for Kandelo"
  homepage "https://libcxx.llvm.org/"
  url "https://github.com/llvm/llvm-project/releases/download/llvmorg-21.1.7/llvm-project-21.1.7.src.tar.xz"
  sha256 "e5b65fd79c95c343bb584127114cb2d252306c1ada1e057899b6aacdd445899e"
  license "Apache-2.0" => { with: "LLVM-exception" }

  depends_on "cmake" => :build

  skip_clean "lib/libc++.a"
  skip_clean "lib/libc++abi.a"

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

    ENV["LLVM_VERSION"] ||= version.to_s
    ENV["WASM_POSIX_LLVM_LIBCXX_SOURCE"] ||= buildpath.to_s
    ENV["WASM_POSIX_LLVM_LIBUNWIND_SOURCE"] ||= buildpath.to_s

    %w[
      LLVM_PREFIX
      LLVM_VERSION
      WASM_POSIX_LLVM_LIBCXX_SOURCE
      WASM_POSIX_LLVM_LIBUNWIND_SOURCE
    ].each do |key|
      odie "#{key} must be provided by scripts/dev-shell.sh for libcxx" if ENV[key].to_s.empty?
    end

    out_dir = buildpath/"kandelo-package-out"
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/libcxx/build-libcxx.sh"

    lib.install out_dir/"lib/libc++.a"
    lib.install out_dir/"lib/libc++abi.a"
    (include/"c++").mkpath
    (include/"c++").install out_dir/"include/c++/v1"
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)

    test_src = testpath/"libcxx-smoke.cpp"
    test_wasm = testpath/"libcxx-smoke.wasm"
    test_src.write <<~CPP
      #include <stdexcept>
      #include <string>
      #include <vector>
      #include <cstdio>

      int main() {
        try {
          std::vector<std::string> values;
          values.push_back("kandelo");
          if (values.size() != 1) throw std::runtime_error("vector failed");
          throw std::runtime_error(values[0]);
        } catch (const std::runtime_error& err) {
          std::printf("libcxx caught %s\\n", err.what());
          return 0;
        }
      }
    CPP

    system "#{kandelo_tool_prefix}-c++",
      "-std=c++20",
      "-fexceptions",
      "-fwasm-exceptions",
      "-mexception-handling",
      "-mllvm",
      "-wasm-enable-sjlj",
      "-mllvm",
      "-wasm-use-legacy-eh=false",
      "-nostdinc++",
      "-isystem",
      "#{include}/c++/v1",
      test_src,
      "#{lib}/libc++.a",
      "#{lib}/libc++abi.a",
      "-o",
      test_wasm
    assert_equal "\0asm".b, File.binread(test_wasm, 4)

    output = run_kandelo_wasm(root, test_wasm)
    assert_match "libcxx caught kandelo", output
  end
end
