require "shellwords"

class Ncurses < Formula
  desc "Terminal handling library and utilities for Kandelo"
  homepage "https://invisible-island.net/ncurses/"
  url "https://ftpmirror.gnu.org/gnu/ncurses/ncurses-6.5.tar.gz"
  sha256 "136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6"
  license "X11"

  skip_clean "bin/clear"
  skip_clean "bin/reset"
  skip_clean "bin/tset"
  skip_clean "bin/tput"
  skip_clean "bin/tabs"
  skip_clean "bin/tic"
  skip_clean "bin/infocmp"
  skip_clean "bin/toe"
  skip_clean "bin/captoinfo"
  skip_clean "bin/infotocap"
  skip_clean "lib/libncursesw.a"
  skip_clean "lib/libtinfow.a"

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
    else odie "ncurses is currently packaged for wasm32 only, got #{kandelo_arch}"
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

  def ncurses_programs
    %w[
      clear reset tset tput tabs tic infocmp toe captoinfo infotocap
    ]
  end

  def install
    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = "https://ftpmirror.gnu.org/gnu/ncurses/ncurses-#{version}.tar.gz"
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = "136d91bc269a9a5785e5f9e980bc76ab57428f604ce3e5a5a90cebc767971cc6"
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir
    ENV["WASM_POSIX_DEP_WORK_DIR"] = buildpath/"kandelo-package-work"
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch

    system "bash", "#{root}/packages/registry/ncurses/build-ncurses.sh"

    lib.install out_dir/"lib/libncursesw.a"
    lib.install out_dir/"lib/libtinfow.a"
    ln_s "libncursesw.a", lib/"libncurses.a"
    ln_s "libtinfow.a", lib/"libtinfo.a"
    include.install out_dir/"include/ncursesw"
    ln_s "ncursesw", include/"ncurses"
    ncurses_programs.each do |program|
      chmod 0755, out_dir/"#{program}.wasm"
      bin.install out_dir/"#{program}.wasm" => program
      chmod 0755, bin/program
    end
  end

  test do
    root = kandelo_root
    configure_kandelo_environment(root)

    tput_wasm = testpath/"tput.wasm"
    File.binwrite(tput_wasm, File.binread(bin/"tput"))
    tput_output = run_kandelo_wasm(root, tput_wasm, "-V")
    assert_match "ncurses", tput_output

    test_src = testpath/"ncurses-smoke.c"
    test_wasm = testpath/"ncurses-smoke.wasm"
    test_src.write <<~C
      #include <ncursesw/curses.h>
      #include <stdio.h>

      int main(void) {
        printf("%s\\n", curses_version());
        return 0;
      }
    C

    system "#{kandelo_tool_prefix}-cc",
      "-I#{include}",
      test_src,
      "#{lib}/libncursesw.a",
      "#{lib}/libtinfow.a",
      "-o",
      test_wasm
    assert_equal "\0asm".b, File.binread(test_wasm, 4)

    output = run_kandelo_wasm(root, test_wasm)
    assert_match "ncurses", output
  end
end
