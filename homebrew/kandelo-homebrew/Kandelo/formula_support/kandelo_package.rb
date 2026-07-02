require "fileutils"
require "shellwords"

module KandeloPackageFormula
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

  def kandelo_sysroot(root)
    "#{root}/#{kandelo_arch == "wasm64" ? "sysroot64" : "sysroot"}"
  end

  def kandelo_wasm32_only!
    odie "unsupported HOMEBREW_KANDELO_ARCH=#{kandelo_arch}" if kandelo_arch != "wasm32"
  end

  def configure_kandelo_environment(root)
    %w[
      CC CXX OBJC OBJCXX CFLAGS CPPFLAGS CXXFLAGS LDFLAGS CPATH
      C_INCLUDE_PATH CPLUS_INCLUDE_PATH OBJC_INCLUDE_PATH SDKROOT
      MACOSX_DEPLOYMENT_TARGET
    ].each { |key| ENV.delete(key) }

    ENV.prepend_path "PATH", "#{root}/sdk/bin"
    ENV["WASM_POSIX_SYSROOT"] = kandelo_sysroot(root)
    ENV["WASM_POSIX_GLUE_DIR"] = "#{root}/libc/glue"
    if (node = ENV["HOMEBREW_KANDELO_NODE"]).to_s != ""
      ENV.prepend_path "PATH", File.dirname(node)
    end
    if (llvm_bin = ENV["HOMEBREW_KANDELO_LLVM_BIN"]).to_s != ""
      ENV["WASM_POSIX_LLVM_DIR"] = llvm_bin
      ENV["LLVM_BIN"] = llvm_bin
      ENV.prepend_path "PATH", llvm_bin
    end
    if (build_path = ENV["HOMEBREW_KANDELO_BUILD_PATH"]).to_s != ""
      ENV.prepend_path "PATH", build_path
    end
  end

  def kandelo_build_package(package, script, source_url, source_sha256, script_env: {}, wasm32_only: true)
    kandelo_wasm32_only! if wasm32_only
    root = kandelo_root
    configure_kandelo_environment(root)

    out_dir = buildpath/"kandelo-package-out"
    ENV["WASM_POSIX_DEP_NAME"] = package
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = source_url
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = source_sha256
    ENV["WASM_POSIX_DEP_SOURCE_DIR"] = buildpath.to_s
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir.to_s
    ENV["WASM_POSIX_DEP_WORK_DIR"] = (buildpath/"kandelo-package-work").to_s
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch
    ENV["WASM_POSIX_DEP_SKIP_LOCAL_INSTALL"] = "1"
    script_env.each { |key, value| ENV[key] = value.to_s }

    system "bash", "#{root}/packages/registry/#{package}/#{script}"
    out_dir
  end

  def kandelo_install_bin(out_dir, wasm_name, installed_name)
    chmod 0755, out_dir/wasm_name
    bin.install out_dir/wasm_name => installed_name
    chmod 0755, bin/installed_name
  end

  def kandelo_install_bin_aliases(target, aliases)
    aliases.each do |alias_name|
      next if alias_name == target
      (bin/alias_name).make_symlink target
    end
  end

  def kandelo_assert_wasm(path)
    assert_equal "\0asm".b, File.binread(path, 4)
  end

  def kandelo_run_wasm(path, argv = [], input: nil, env: {})
    root = kandelo_root
    configure_kandelo_environment(root)

    test_wasm = testpath/"#{File.basename(path)}.wasm"
    File.binwrite(test_wasm, File.binread(path))

    env_prefix = env.map { |key, value| "#{key}=#{value.to_s.shellescape}" }.join(" ")
    command = [
      ("#{env_prefix} " unless env_prefix.empty?),
      "node --experimental-wasm-exnref --import tsx/esm",
      "examples/run-example.ts",
      test_wasm.to_s.shellescape,
      argv.map(&:to_s).shelljoin,
    ].compact.join(" ")
    command = "cd #{root.shellescape} && #{command}"

    if input.nil?
      shell_output(command)
    else
      pipe_output(command, input, 0)
    end
  end
end
