module KandeloFormulaSupport
  def kandelo_root
    root = ENV["HOMEBREW_KANDELO_ROOT"] || ENV["KANDELO_HOMEBREW_KANDELO_ROOT"]
    odie "HOMEBREW_KANDELO_ROOT must point at a Kandelo checkout" if root.to_s.empty?
    root
  end

  def kandelo_arch
    ENV.fetch("HOMEBREW_KANDELO_ARCH", ENV.fetch("KANDELO_HOMEBREW_ARCH", "wasm32"))
  end

  def configure_kandelo_environment(root = kandelo_root)
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
    if (rust_bin = ENV["HOMEBREW_KANDELO_RUST_BIN"]).to_s != ""
      ENV.prepend_path "PATH", rust_bin
    end
    if (binaryen_bin = ENV["HOMEBREW_KANDELO_BINARYEN_BIN"]).to_s != ""
      ENV.prepend_path "PATH", binaryen_bin
    end
    if (pkg_config = ENV["HOMEBREW_KANDELO_PKG_CONFIG"]).to_s != ""
      ENV["PKG_CONFIG"] = pkg_config
    end
  end

  def prepare_kandelo_package_env(source_url:, source_sha256:)
    out_dir = buildpath/"kandelo-package-out"
    ENV["WASM_POSIX_DEP_VERSION"] = version.to_s
    ENV["WASM_POSIX_DEP_SOURCE_URL"] = source_url
    ENV["WASM_POSIX_DEP_SOURCE_SHA256"] = source_sha256
    ENV["WASM_POSIX_DEP_OUT_DIR"] = out_dir.to_s
    ENV["WASM_POSIX_DEP_WORK_DIR"] = (buildpath/"kandelo-package-work").to_s
    ENV["WASM_POSIX_DEP_TARGET_ARCH"] = kandelo_arch
    ENV["WASM_POSIX_SKIP_LOCAL_BINARY_INSTALL"] = "1"
    ENV["CARGO_TARGET_DIR"] = (buildpath/"kandelo-cargo-target").to_s
    out_dir
  end

  def install_kandelo_wasm(out_dir, wasm_name, installed_name = wasm_name.delete_suffix(".wasm"))
    source = out_dir/wasm_name
    chmod 0755, source
    bin.install source => installed_name
    chmod 0755, bin/installed_name
  end

  def assert_kandelo_wasm(installed_name)
    assert_equal "\0asm".b, File.binread(bin/installed_name, 4)
  end

  def shell_output_kandelo_wasm(installed_name, args = [], stderr: true)
    root = kandelo_root
    configure_kandelo_environment(root)
    test_wasm = testpath/"#{installed_name}.wasm"
    File.binwrite(test_wasm, File.binread(bin/installed_name))
    redirect = stderr ? " 2>&1" : ""
    shell_output(
      "cd #{root.shellescape} && node --experimental-wasm-exnref --import tsx/esm examples/run-example.ts #{test_wasm.to_s.shellescape} #{args.shelljoin}#{redirect}",
    )
  end
end
