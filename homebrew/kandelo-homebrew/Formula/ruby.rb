require_relative "../Kandelo/formula_support/kandelo_package"

class Ruby < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.5.tar.gz"
  SOURCE_SHA256 = "7d6149079a63f8ae1d326c9fa65c6019ba2dc3155eae7b39159817911c88958e"

  desc "Ruby interpreter for Kandelo"
  homepage "https://www.ruby-lang.org/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license any_of: ["Ruby", "BSD-2-Clause"]

  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "bin"
  skip_clean "lib/ruby"

  def install
    out_dir = kandelo_build_package("ruby", "build-ruby.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "RUBY_VERSION" => version.to_s,
        "WASM_POSIX_DEP_ZLIB_DIR" => Formula["automattic/kandelo-homebrew/zlib"].opt_prefix,
      })
    kandelo_install_bin(out_dir, "ruby.wasm", "ruby")

    runtime_stage = buildpath/"ruby-runtime-stage"
    system "unzip", "-q", out_dir/"ruby-runtime.zip", "-d", runtime_stage
    (lib/"ruby").install Dir["#{runtime_stage}/usr/lib/ruby/*"]
    bin.install Dir["#{runtime_stage}/usr/bin/*"]
  end

  test do
    output = kandelo_run_wasm(bin/"ruby", ["-e", "puts 'ruby-ok'"],
      env: { "RUBYLIB" => (lib/"ruby/4.0.0").to_s, "HOME" => testpath.to_s })
    assert_equal "ruby-ok\n", output
  end
end
