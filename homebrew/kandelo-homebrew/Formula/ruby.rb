require "fileutils"
require_relative "../Kandelo/formula_support/kandelo_package"

class Ruby < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.5.tar.gz"
  SOURCE_SHA256 = "7d6149079a63f8ae1d326c9fa65c6019ba2dc3155eae7b39159817911c88958e"

  desc "Ruby interpreter and runtime for Kandelo"
  homepage "https://www.ruby-lang.org/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license any_of: ["Ruby", "BSD-2-Clause"]

  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("ruby", "build-ruby.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "RUBY_VERSION" => version.to_s,
        "WASM_POSIX_DEP_ZLIB_DIR" => Formula["automattic/kandelo-homebrew/zlib"].opt_prefix.to_s,
      })
    kandelo_install_bin(out_dir, "ruby.wasm", "ruby")

    runtime_zip = out_dir/"ruby-runtime.zip"
    runtime_stage = buildpath/"ruby-runtime-stage"
    rm_rf runtime_stage
    mkdir_p runtime_stage
    system "unzip", "-q", runtime_zip, "-d", runtime_stage
    lib.install runtime_stage/"usr/lib/ruby"
    share.install runtime_zip
  end

  test do
    output = kandelo_run_wasm(bin/"ruby", ["-e", "puts 2 + 3"],
      env: { "RUBYLIB" => (lib/"ruby/#{version.major_minor}.0").to_s })
    assert_match "5", output
  end
end
