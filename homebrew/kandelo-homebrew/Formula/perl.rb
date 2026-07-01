require_relative "../Kandelo/formula_support/kandelo_package"

class Perl < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://www.cpan.org/src/5.0/perl-5.40.3.tar.gz"
  SOURCE_SHA256 = "4c155bf771a300ebdb8269916ef5b22cf1bc3a92e9540ea6608bb54b0a890bd0"
  PERL_CROSS_SHA256 = "b6202173b0a8a43fb312867d85a8cd33527f3f234b1b6e591cdaa9895c9920c7"

  desc "Perl interpreter for Kandelo"
  homepage "https://www.perl.org/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license any_of: ["Artistic-1.0-Perl", "GPL-1.0-or-later"]

  skip_clean "bin"
  skip_clean "lib/perl5"

  def install
    out_dir = kandelo_build_package("perl", "build-perl.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: {
        "PERL_VERSION" => version.to_s,
        "PERL_CROSS_SOURCE_SHA256" => PERL_CROSS_SHA256,
      })
    kandelo_install_bin(out_dir, "perl.wasm", "perl")
    install_perl_runtime
  end

  def install_perl_runtime
    dest = lib/"perl5/#{version}"
    dest.mkpath
    [buildpath/"lib"].each { |dir| FileUtils.cp_r("#{dir}/.", dest) if dir.directory? }
    %w[cpan dist ext].each do |group|
      Dir[buildpath/"#{group}/*/lib"].each { |dir| FileUtils.cp_r("#{dir}/.", dest) }
    end
    warnings = dest/"warnings.pm"
    inreplace warnings, "delete @warnings::{qw(NORMAL FATAL MESSAGE LEVEL)};",
      "# delete @warnings::{qw(NORMAL FATAL MESSAGE LEVEL)}; # patched for wasm32" if warnings.exist?
  end

  test do
    output = kandelo_run_wasm(bin/"perl", ["-e", "print qq(perl-ok\\n)"],
      env: { "PERL5LIB" => (lib/"perl5/#{version}").to_s })
    assert_equal "perl-ok\n", output
  end
end
