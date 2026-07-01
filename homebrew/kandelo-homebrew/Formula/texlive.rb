require "base64"
require "json"
require_relative "../Kandelo/formula_support/kandelo_package"

class Texlive < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/texlive-20250308-source.tar.xz"
  SOURCE_SHA256 = "fffdb1a3d143c177a4398a2229a40d6a88f18098e5f6dcfd57648c9f2417490f"

  desc "Minimal TeX Live pdfTeX runtime for Kandelo"
  homepage "https://www.tug.org/texlive/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "LicenseRef-TeXLive-Various"

  depends_on "automattic/kandelo-homebrew/libpng"
  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "bin"
  skip_clean "share/texmf-dist"

  def install
    out_dir = kandelo_build_package("texlive", "build-texlive.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "TEXLIVE_VERSION" => version.to_s,
        "WASM_POSIX_DEP_LIBPNG_DIR" => Formula["automattic/kandelo-homebrew/libpng"].opt_prefix,
        "WASM_POSIX_DEP_ZLIB_DIR" => Formula["automattic/kandelo-homebrew/zlib"].opt_prefix,
      })
    kandelo_install_bin(out_dir, "pdftex.wasm", "pdftex")
    install_bundle(out_dir/"texlive-bundle.json")
  end

  def install_bundle(bundle)
    data = JSON.parse(File.read(bundle))
    data.fetch("files").each do |entry|
      rel = entry.fetch("path").sub(%r{\A/usr/}, "")
      dest = prefix/rel
      dest.dirname.mkpath
      File.binwrite(dest, Base64.decode64(entry.fetch("data")))
      chmod 0644, dest
    end
  end

  test do
    output = kandelo_run_wasm(bin/"pdftex", ["--version"],
      env: {
        "TEXMFDIST" => (share/"texmf-dist").to_s,
        "TEXMFCNF" => (share/"texmf-dist/web2c").to_s,
      })
    assert_match "pdfTeX", output
  end
end
