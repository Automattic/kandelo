require_relative "../Kandelo/formula_support/kandelo_package"

class Erlang < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://github.com/erlang/otp/archive/refs/tags/OTP-28.2.tar.gz"
  SOURCE_SHA256 = "b984f9e02bb61637997a35daa9070ae8f41cea1667676416438c467fda3d141f"

  desc "Erlang/OTP BEAM runtime for Kandelo"
  homepage "https://www.erlang.org/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "Apache-2.0"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("erlang", "build-erlang.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "OTP_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "erlang.wasm", "erlang")
    (libexec/"erlang").mkpath
    system "tar", "--zstd", "-xf", out_dir/"erlang-otp.tar.zst", "-C", libexec/"erlang"
  end

  test do
    kandelo_assert_wasm(bin/"erlang")
    assert_predicate libexec/"erlang/releases/28/start_clean.boot", :exist?
  end
end
