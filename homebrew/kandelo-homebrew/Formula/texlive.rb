require "base64"
require "json"
require_relative "../Kandelo/formula_support/kandelo_package"

class Texlive < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/texlive-20250308-source.tar.xz"
  SOURCE_SHA256 = "fffdb1a3d143c177a4398a2229a40d6a88f18098e5f6dcfd57648c9f2417490f"
  TEXLIVE_RELEASE = "2025"

  desc "TeX Live pdftex engine and runtime bundle for Kandelo"
  homepage "https://www.tug.org/texlive/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license "LicenseRef-TeXLive-Various"

  depends_on "automattic/kandelo-homebrew/libpng"
  depends_on "automattic/kandelo-homebrew/zlib"

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("texlive", "build-texlive.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "TEXLIVE_VERSION" => TEXLIVE_RELEASE,
        "WASM_POSIX_DEP_LIBPNG_DIR" => Formula["automattic/kandelo-homebrew/libpng"].opt_prefix.to_s,
        "WASM_POSIX_DEP_ZLIB_DIR" => Formula["automattic/kandelo-homebrew/zlib"].opt_prefix.to_s,
    })
    kandelo_install_bin(out_dir, "pdftex.wasm", "pdftex")
    install_texlive_bundle(out_dir/"texlive-bundle.json")
    (share/"texlive").install out_dir/"texlive-bundle.json"
  end

  test do
    output = kandelo_run_wasm(bin/"pdftex", ["--version"],
      env: { "TEXMFCNF" => (share/"texmf-dist/web2c").to_s })
    assert_match "pdfTeX", output
    assert_predicate share/"texmf-dist/web2c/texmf.cnf", :exist?
  end

  def install_texlive_bundle(bundle_path)
    bundle = JSON.parse(File.read(bundle_path))
    files = bundle.fetch("files")
    files.each do |entry|
      guest_path = entry.fetch("path")
      next unless guest_path.start_with?("/usr/share/texmf-dist/")

      target = share/guest_path.delete_prefix("/usr/share/")
      target.dirname.mkpath
      File.binwrite(target, Base64.decode64(entry.fetch("data")))
    end
  end
end
